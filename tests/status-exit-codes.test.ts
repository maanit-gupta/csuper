import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Io } from "../src/cli/common.js";
import { runCtl } from "../src/cli/ctl.js";
import { runLogs } from "../src/cli/logs.js";
import { runSessions } from "../src/cli/sessions.js";
import { exitCodeFor, runStatus } from "../src/cli/status.js";
import { IpcServer } from "../src/ipc-server.js";
import { Logger } from "../src/logger.js";
import { sessionsDir, logsDir } from "../src/paths.js";
import { sockPathFor, writeSessionInfo } from "../src/session-registry.js";
import { statusText } from "../src/cli/format.js";
import { iso, NOW, sampleState, tmpHome } from "./fixtures.js";

function capture(): Io & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, out: (s) => stdout.push(s), err: (s) => stderr.push(s) };
}

describe("exitCodeFor", () => {
  const base = sampleState();
  it("0 when running with autopilot on", () => expect(exitCodeFor(base)).toBe(0));
  it("0 while on the failover model", () => expect(exitCodeFor({ ...base, rateLimit: { ...base.rateLimit, status: "failover" } })).toBe(0));
  it("1 when paused by the user or outside active hours", () => {
    expect(exitCodeFor({ ...base, autopilot: { enabled: false, pausedReason: "user" } })).toBe(1);
    expect(exitCodeFor({ ...base, autopilot: { enabled: false, pausedReason: "hours" } })).toBe(1);
    expect(exitCodeFor({ ...base, autopilot: { enabled: false, pausedReason: null } })).toBe(1);
  });
  it("1 when waiting on a rate limit", () => expect(exitCodeFor({ ...base, rateLimit: { ...base.rateLimit, status: "waiting" } })).toBe(1));
  it("3 for an active anomaly or tripped breaker, even if also waiting", () => {
    expect(exitCodeFor({ ...base, autopilot: { enabled: false, pausedReason: "anomaly" } })).toBe(3);
    expect(
      exitCodeFor({ ...base, autopilot: { enabled: false, pausedReason: "breaker" }, rateLimit: { ...base.rateLimit, status: "waiting" } }),
    ).toBe(3);
  });
});

describe("cycles and rate limits in `csuper status`", () => {
  it("3 when a cycle failed or csuper gave up resuming after a limit", () => {
    const base = sampleState();
    expect(exitCodeFor({ ...base, autopilot: { enabled: false, pausedReason: "cycle_failed" } })).toBe(3);
    expect(exitCodeFor({ ...base, autopilot: { enabled: false, pausedReason: "ratelimit" } })).toBe(3);
    expect(exitCodeFor({ ...base, autopilot: { enabled: false, pausedReason: "complete" } })).toBe(1);
    expect(exitCodeFor({ ...base, rateLimit: { ...base.rateLimit, status: "resuming" } })).toBe(0);
  });

  it("text output lists cycles (totals, live step, last cycles) and the wait", () => {
    const s = sampleState();
    s.rateLimit = { ...s.rateLimit, status: "waiting", reason: "5-hour limit", resetAt: iso(3600e3), resumeAt: iso(3690e3), resumeAttempts: 2, failedResumes: 1, waitStartedAt: iso(-60e3) };
    const out = statusText(s, NOW);
    expect(out).toContain("cycles    3/20 ok · 1 failed · last ok 07:26:00 (4m 00s ago)  now 2/8 countdown");
    expect(out).toContain("#4 07:25:00 1m 00s  ok  phase 3: Auth refactor");
    expect(out).toContain("#2 07:05:00 35s     failed at clear_confirmed");
    expect(out).toContain("ratelimit waiting (5-hour limit)  resets 08:30:00 (1h 00m)  resume at 08:31:30 (in 1h 01m)");
    expect(out).toContain("resumes 2 sent, 1 failed in a row  waited 1h 32m");
  });
});

describe("one-shot commands against a live daemon", () => {
  let home: string;
  let servers: IpcServer[] = [];
  const prevHome = process.env.CSUPER_HOME;

  async function daemon(id: string, state = sampleState(), onControl?: ConstructorParameters<typeof IpcServer>[0]["onControl"]) {
    writeSessionInfo({ id, pid: process.pid, claude_pid: process.pid, cwd: "/tmp/p", started_at: new Date().toISOString(), config_path: null, version: "0.1.0" });
    const srv = new IpcServer({ sockPath: sockPathFor(id), initialState: { ...state, session: { ...state.session, id } }, onControl });
    await srv.listen();
    servers.push(srv);
    return srv;
  }

  beforeEach(() => {
    home = tmpHome("cse-");
    process.env.CSUPER_HOME = home;
    delete process.env.CSUPER_SESSION;
  });
  afterEach(async () => {
    await Promise.all(servers.map((s) => s.close()));
    servers = [];
    process.env.CSUPER_HOME = prevHome;
    if (prevHome === undefined) delete process.env.CSUPER_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("status: 2 when there is no session", async () => {
    const io = capture();
    expect(await runStatus({}, io)).toBe(2);
    expect(io.stderr.join()).toMatch(/no live csuper session/);
  });

  it("status: 0 and prints JSON snapshot for the only live session", async () => {
    await daemon("aaaaaa");
    const io = capture();
    expect(await runStatus({ json: true }, io)).toBe(0);
    expect(JSON.parse(io.stdout[0]).session.id).toBe("aaaaaa");
  });

  it("status: 2 and lists sessions when ambiguous", async () => {
    await daemon("aaaaaa");
    await daemon("bbbbbb");
    const io = capture();
    expect(await runStatus({}, io)).toBe(2);
    expect(io.stderr.join("\n")).toMatch(/aaaaaa[\s\S]*bbbbbb/);
    expect(await runStatus({ session: "bbbbbb" }, capture())).toBe(0);
  });

  it("status: 1 when paused, 3 on anomaly, 4 when stale", async () => {
    await daemon("aaaaaa", sampleState({ autopilot: { enabled: false, pausedReason: "user" } }));
    await daemon("bbbbbb", sampleState({ autopilot: { enabled: false, pausedReason: "anomaly" } }));
    expect(await runStatus({ session: "aaaaaa" }, capture())).toBe(1);
    expect(await runStatus({ session: "bbbbbb" }, capture())).toBe(3);
    writeSessionInfo({ id: "cccccc", pid: process.pid, claude_pid: 1, cwd: "/", started_at: "", config_path: null, version: "" });
    fs.writeFileSync(sockPathFor("cccccc"), ""); // leftover socket, nobody listening
    const io = capture();
    expect(await runStatus({ session: "cccccc" }, io)).toBe(4);
    expect(io.stderr.join()).toMatch(/not responding/);
  });

  it("sessions: lists and prunes stale sessions", async () => {
    await daemon("aaaaaa");
    writeSessionInfo({ id: "bbbbbb", pid: 999_999, claude_pid: 1, cwd: "/", started_at: "", config_path: null, version: "" });
    const io = capture();
    await runSessions({ json: true }, io);
    const list = JSON.parse(io.stdout[0]);
    expect(list.map((s: any) => [s.id, s.status])).toEqual([["aaaaaa", "live"], ["bbbbbb", "stale"]]);
    const io2 = capture();
    await runSessions({ prune: true }, io2);
    expect(io2.stdout[0]).toMatch(/bbbbbb/);
    expect(fs.readdirSync(sessionsDir()).sort()).toEqual(["aaaaaa.json", "aaaaaa.sock"]);
  });

  it("ctl: sends allow-listed actions, confirms skip-wait", async () => {
    const calls: string[] = [];
    await daemon("aaaaaa", sampleState(), (a) => (calls.push(a), { ok: true }));
    expect(await runCtl({ verb: "pause" }, capture())).toBe(0);
    expect(await runCtl({ verb: "cancel-countdown" }, capture())).toBe(0);
    // Declined confirmation → nothing sent
    expect(await runCtl({ verb: "skip-wait", confirm: async () => false }, capture())).toBe(1);
    expect(await runCtl({ verb: "skip-wait", confirm: async () => true }, capture())).toBe(0);
    expect(await runCtl({ verb: "skip-wait", yes: true, confirm: async () => false }, capture())).toBe(0);
    expect(calls).toEqual(["autopilot.pause", "countdown.cancel", "ratelimit.skip_wait", "ratelimit.skip_wait"]);
    expect(await runCtl({ verb: "rm-rf" }, capture())).toBe(64);
  });

  it("ctl: reports a failed ack", async () => {
    await daemon("aaaaaa", sampleState(), () => ({ ok: false, error: "no countdown pending" }));
    const io = capture();
    expect(await runCtl({ verb: "cancel-countdown" }, io)).toBe(1);
    expect(io.stderr[0]).toMatch(/no countdown pending/);
  });

  it("logs: filters, limits, raw mode and follow", async () => {
    await daemon("aaaaaa");
    const log = new Logger({ session: "aaaaaa", file: path.join(logsDir(), "aaaaaa.jsonl") });
    log.info("trigger.matched", "hit one");
    log.warn("anomaly.detected", "streak");
    log.error("hook.error", "bad hook");
    log.debug("command.injected", "/clear");

    let io = capture();
    await runLogs({ level: "warn" }, io);
    expect(io.stdout).toHaveLength(2);
    io = capture();
    await runLogs({ event: "anomaly.detected", raw: true }, io);
    expect(JSON.parse(io.stdout[0]).msg).toBe("streak");
    const stored = fs.readFileSync(path.join(logsDir(), "aaaaaa.jsonl"), "utf8").split("\n").find((l) => l.includes("anomaly.detected"));
    expect(io.stdout[0]).toBe(stored); // --raw prints lines exactly as stored
    io = capture();
    await runLogs({ n: 1 }, io);
    expect(io.stdout[0]).toMatch(/command\.injected/);
    expect(await runLogs({ since: "whenever" }, capture())).toBe(64);

    io = capture();
    const ac = new AbortController();
    const p = runLogs({ follow: true, n: 0, level: "warn", raw: true, signal: ac.signal }, io);
    await new Promise((r) => setTimeout(r, 100));
    log.info("command.injected", "ignored by level filter");
    log.error("breaker.tripped", "tripped");
    const end = Date.now() + 3000;
    while (!io.stdout.some((l) => l.includes("breaker.tripped")) && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    await p;
    const followed = io.stdout.map((l) => JSON.parse(l).event);
    expect(followed).toEqual(["breaker.tripped"]); // -n 0 prints no history; filter drops the info line
  });

  it("logs: works for an ended session given --session", async () => {
    fs.mkdirSync(logsDir(), { recursive: true });
    new Logger({ session: "dddddd", file: path.join(logsDir(), "dddddd.jsonl") }).info("session.start", "hi");
    const io = capture();
    expect(await runLogs({ session: "dddddd" }, io)).toBe(0);
    expect(io.stdout[0]).toMatch(/session\.start/);
  });
});
