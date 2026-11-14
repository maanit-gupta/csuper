import fs from "node:fs";
import path from "node:path";
import { render } from "ink-testing-library";
import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import { App, readLogTail } from "../src/cli/dash.js";
import { DashView, initialUi, type DashViewProps } from "../src/cli/DashView.js";
import { IpcServer } from "../src/ipc-server.js";
import { Logger, type LogRecord } from "../src/logger.js";
import { logsDir } from "../src/paths.js";
import { sockPathFor, writeSessionInfo } from "../src/session-registry.js";
import { iso, NOW, sampleState, tmpHome } from "./fixtures.js";

const cfg = defaultConfig().dashboard;
const logs: LogRecord[] = [
  { ts: iso(-90e3), level: "info", session: "a1b2c3", event: "trigger.matched", msg: "::DONE:: matched (last_line)", data: { trigger: "task_complete" } },
  { ts: iso(-60e3), level: "warn", session: "a1b2c3", event: "anomaly.detected", msg: "edit thrash on src/app.ts" },
  { ts: iso(-30e3), level: "error", session: "a1b2c3", event: "hook.error", msg: "PostToolUse hook exited 1" },
];

function view(over: Partial<DashViewProps> = {}) {
  const props: DashViewProps = {
    state: sampleState(),
    conn: "connected",
    sessionId: "a1b2c3",
    now: NOW,
    cfg,
    ui: initialUi(cfg),
    logs,
    handoverLines: ["# Handover", "", "## Next", "- wire TUI"],
    sessions: [],
    columns: 100,
    rows: 40,
    ...over,
  };
  return render(<DashView {...props} />).lastFrame()!;
}

describe("DashView snapshots", () => {
  it("renders all six panels", () => {
    const f = view();
    for (const t of ["1 Session & Autopilot", "2 Rate Limits & Quota", "3 Cycles", "4 Triggers & Anomalies", "5 Git & Handover", "6 Log Stream"]) expect(f).toContain(t);
    expect(f).toContain("/clear /next in 4s"); // countdown from absolute firesAt
    expect(f).toContain("1h 12m"); // 5h window reset
    expect(f).toContain("3d 4h"); // weekly reset
    // Cycles panel: totals, the live step, and the last cycles newest first
    expect(f).toContain("3/20 · failed 1 · last ok 07:26:00 (4m 00s ago)");
    expect(f).toContain("2/8 countdown · fires in 4s (c cancels)");
    expect(f).toMatch(/07:25:00 1m 00s\s+ok\s+3: Auth refactor/);
    expect(f).toMatch(/07:05:00 35s\s+failed at clear_confirmed/);
    expect(f.indexOf("07:25:00")).toBeLessThan(f.indexOf("06:50:00"));
    expect(f).toContain("cycles 3/20 (2/8)"); // status bar
    expect(f).toContain("—"); // weekly % not sourced yet
    expect(f).toContain("9f3c2ab");
    expect(f).toContain("wire TUI");
    expect(f).toMatchSnapshot();
  });

  it("an adopted session shows 'adopted from' without clipping the rest of the panel", () => {
    const base = sampleState();
    const f = view({ state: { ...base, session: { ...base.session, adoptedFrom: "4296de70-9ff1-42e7-9177-cba863e491cf" } } });
    expect(f).toContain("adopted from 4296de70");
    expect(f).toContain("csuper 4242 · claude 4243"); // the last row still fits
    expect(view()).not.toContain("adopted from");
  });

  it("shows PAUSED with reason and a DISCONNECTED banner", () => {
    const f = view({ conn: "disconnected", state: sampleState({ autopilot: { enabled: false, pausedReason: "breaker" } }) });
    expect(f).toContain("PAUSED");
    expect(f).toContain("(breaker)");
    expect(f).toContain("DISCONNECTED");
    expect(f).toMatchSnapshot();
  });

  it("shows the live cycle step and keeps cycles in the status bar in every view", () => {
    const s = sampleState({ countdown: null });
    s.cycles = { ...s.cycles, current: { ...s.cycles.current!, step: 4, name: "clear_confirmed", label: "waiting for clear confirmation", deadline: iso(18e3) } };
    expect(view({ state: s })).toContain("4/8 waiting for clear confirmation · times out in 18s");
    expect(view({ state: s, ui: { ...initialUi(cfg), logFullscreen: true } })).toContain("cycles 3/20 (4/8)");
    expect(view({ state: s, ui: { ...initialUi(cfg), mode: "help" } })).toContain("cycles 3/20");
    expect(view({ state: s, ui: { ...initialUi(cfg), mode: "filter", filterText: "x" } })).toContain("cycles 3/20");
    expect(view({ state: s, ui: { ...initialUi(cfg), mode: "confirm-skip" } })).toContain("cycles 3/20");
    // A short terminal keeps the summary rows
    const small = view({ state: s, rows: 30 });
    expect(small).toContain("3/20 · failed 1");
    expect(small).toContain("4/8 waiting for clear confirmation");
  });

  it("shows the rate-limit wait: reason, reset, countdown, attempts, total waited, failover", () => {
    const s = sampleState({ countdown: null });
    s.rateLimit = {
      ...s.rateLimit,
      status: "waiting",
      reason: "5-hour limit",
      source: "hook",
      resetAt: iso(3600e3),
      resumeAt: iso(3690e3),
      waitStartedAt: iso(-20 * 60e3),
      resumeAttempts: 1,
      failedResumes: 1,
      totalWaitMs: 3600e3,
      failovers: [{ ts: iso(-3600e3), from: "opus", to: "sonnet", reason: "Opus limit", restoredAt: null }],
      modelRestoreAt: iso(5 * 3600e3),
    };
    const f = view({ state: s, columns: 140 });
    expect(f).toContain("waiting · 5-hour limit (hook)");
    expect(f).toContain("08:30:00 (1h 00m)"); // reset
    expect(f).toContain("08:31:30 in 1h 01m"); // resume countdown incl. margin
    expect(f).toContain("1 sent · 1 failed in a row");
    expect(f).toContain("1h 20m this session"); // 1h finished + 20m in progress
    expect(f).toContain("opus→sonnet 06:30:00 · back after 12:30:00");
  });

  it("shows waiting state with resume time", () => {
    const s = sampleState({ countdown: null });
    s.rateLimit = { ...s.rateLimit, status: "waiting", resumeAt: iso(10 * 60e3), weeklyPct: 95 };
    const f = view({ state: s });
    expect(f).toContain("waiting");
    expect(f).toContain("in 10m 00s");
    expect(f).toContain("95%");
    expect(f).toMatchSnapshot();
  });

  it("renders help, switcher, confirm and filter modes", () => {
    expect(view({ ui: { ...initialUi(cfg), mode: "help" } })).toMatchSnapshot("help");
    const sessions = [
      { id: "a1b2c3", status: "live" as const, info: null, sockPath: "", jsonPath: "" },
      { id: "d4e5f6", status: "stale" as const, info: null, sockPath: "", jsonPath: "" },
    ];
    const sw = view({ ui: { ...initialUi(cfg), mode: "switcher", switcherIndex: 1 }, sessions });
    expect(sw).toContain("[stale]");
    expect(sw).toContain("(current)");
    expect(view({ ui: { ...initialUi(cfg), mode: "confirm-skip" } })).toContain("[y/N]");
    expect(view({ ui: { ...initialUi(cfg), mode: "filter", filterText: "hook" } })).toContain("/hook");
  });

  it("renders the full-screen log", () => {
    const f = view({ ui: { ...initialUi(cfg), logFullscreen: true } });
    expect(f).toContain("esc to exit");
    expect(f).not.toContain("Rate Limits");
    expect(f).toMatchSnapshot();
  });

  it("keeps the (current) marker visible when the session's cwd is very long", () => {
    const info = { id: "a1b2c3", pid: 1, claude_pid: 2, cwd: "/very/long/" + "nested/".repeat(30) + "project", started_at: "", config_path: null, version: "" };
    const sessions = [{ id: "a1b2c3", status: "live" as const, info, sockPath: "", jsonPath: "" }];
    expect(view({ ui: { ...initialUi(cfg), mode: "switcher" }, sessions })).toContain("(current)");
  });

  it("shows the picker with no session", () => {
    expect(view({ sessionId: null, state: null })).toContain("No csuper sessions yet");
  });

  it("doesn't show DISCONNECTED or session controls while waiting for a session", () => {
    const f = view({ sessionId: null, state: null, conn: "disconnected", sessions: [] });
    expect(f).toContain("WAITING FOR A SESSION");
    expect(f).toContain("csuper resume");
    expect(f).not.toContain("DISCONNECTED");
    expect(f).not.toContain("pause");
    expect(f).not.toContain("Enter open");
  });
});

describe("App (live socket)", () => {
  let home: string;
  let server: IpcServer;
  const prev = process.env.CSUPER_HOME;
  const calls: string[] = [];
  const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));
  const until = async (cond: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error("timeout; last frame:\n" + (globalThis as any).__lastFrame?.());
      await tick(20);
    }
  };

  beforeEach(async () => {
    home = tmpHome("cst-");
    process.env.CSUPER_HOME = home;
    delete process.env.CSUPER_SESSION;
    calls.length = 0;
    writeSessionInfo({ id: "a1b2c3", pid: process.pid, claude_pid: process.pid, cwd: "/tmp/p", started_at: new Date().toISOString(), config_path: null, version: "0.1.0" });
    const logger = new Logger({ session: "a1b2c3", file: path.join(logsDir(), "a1b2c3.jsonl") });
    logger.info("session.start", "from file history");
    const s = sampleState();
    s.countdown = { ...s.countdown!, firesAt: new Date(Date.now() + 60e3).toISOString() };
    s.rateLimit.status = "waiting";
    server = new IpcServer({
      sockPath: sockPathFor("a1b2c3"),
      initialState: s,
      logger,
      onControl: (a) => {
        calls.push(a);
        if (a === "autopilot.pause") server.patchState({ autopilot: { enabled: false, pausedReason: "user" } });
        return { ok: true };
      },
    });
    await server.listen();
  });

  afterEach(async () => {
    await server.close();
    process.env.CSUPER_HOME = prev;
    if (prev === undefined) delete process.env.CSUPER_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("auto-selects the only session, streams logs, and sends controls via keys", async () => {
    const config = defaultConfig();
    const ui = render(<App opts={{}} config={config} configPath={null} />);
    (globalThis as any).__lastFrame = () => ui.lastFrame();
    await until(() => ui.lastFrame()!.includes("CONNECTED") && ui.lastFrame()!.includes("from file history"));

    server.getState(); // live log via socket
    (server as any).opts.logger.warn("anomaly.detected", "live line over socket");
    await until(() => ui.lastFrame()!.includes("live line over socket"));

    ui.stdin.write("p");
    await until(() => ui.lastFrame()!.includes("PAUSED"));
    ui.stdin.write("c");
    await until(() => calls.includes("countdown.cancel"));

    ui.stdin.write("w"); // asks first
    await until(() => ui.lastFrame()!.includes("[y/N]"));
    ui.stdin.write("n");
    await tick();
    expect(calls).not.toContain("ratelimit.skip_wait");
    ui.stdin.write("w");
    await until(() => ui.lastFrame()!.includes("[y/N]"));
    ui.stdin.write("y");
    await until(() => calls.includes("ratelimit.skip_wait"));

    // f cycles level: info+ → warn+ hides the info line
    ui.stdin.write("f");
    await until(() => ui.lastFrame()!.includes("level warn+"));
    expect(ui.lastFrame()).not.toContain("from file history");

    // Text filter
    ui.stdin.write("/");
    await tick();
    for (const ch of "zzz") ui.stdin.write(ch);
    await until(() => ui.lastFrame()!.includes("(no log lines match)"));
    ui.stdin.write("\x1b"); // Esc clears
    await until(() => ui.lastFrame()!.includes("live line over socket"));

    ui.stdin.write("?");
    await until(() => ui.lastFrame()!.includes("csuper dash — keys"));
    ui.stdin.write("x");
    await until(() => !ui.lastFrame()!.includes("csuper dash — keys"));

    expect(calls).toEqual(["autopilot.pause", "countdown.cancel", "ratelimit.skip_wait"]);
    ui.unmount();
  });

  it("shows DISCONNECTED when the daemon goes away", async () => {
    const ui = render(<App opts={{ session: "a1b2c3" }} config={defaultConfig()} configPath={null} />);
    await until(() => ui.lastFrame()!.includes("● CONNECTED"));
    await server.close();
    await until(() => ui.lastFrame()!.includes("DISCONNECTED"));
    // Restart so afterEach can close it again
    server = new IpcServer({ sockPath: sockPathFor("a1b2c3"), initialState: sampleState({ model: "sonnet" }) });
    await server.listen();
    await until(() => ui.lastFrame()!.includes("● CONNECTED") && ui.lastFrame()!.includes("sonnet"), 5000);
    ui.unmount();
  });
});

describe("readLogTail", () => {
  it("returns the last N valid records", () => {
    const dir = tmpHome("csr-");
    const f = path.join(dir, "x.jsonl");
    const log = new Logger({ session: "x", file: f });
    for (let i = 0; i < 50; i++) log.info("command.injected", `n${i}`);
    fs.appendFileSync(f, "garbage\n");
    const t = readLogTail(f, 5);
    expect(t.map((r) => r.msg)).toEqual(["n45", "n46", "n47", "n48", "n49"]);
    expect(readLogTail(path.join(dir, "missing.jsonl"), 5)).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
