import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openModeFor, parseAdoptArgv, planItem, shq, summaryTable, tabCommand, tabLauncher } from "../src/cli/adopt.js";
import { defaultConfig, parseConfig } from "../src/config.js";
import { readSessionInfo, writeSessionInfo } from "../src/session-registry.js";
import {
  classifySession,
  detectLiveClaudes,
  isClaudeCommand,
  listAllClaudeSessions,
  parseLsofCwd,
  parsePs,
  type ClaudeSession,
  type LiveClaudes,
} from "../src/supervisor/claude-sessions.js";
import { ancestorsOf, checkSignalTarget, signalContext, stopOriginal, supervisedClaudes, type SignalContext } from "../src/supervisor/stop-original.js";
import { tmpHome } from "./fixtures.js";

const FIXTURE = path.resolve(__dirname, "fixtures", "claude-home");
const A = "aaaaaaaa-1111-4111-8111-111111111111";
const B = "bbbbbbbb-2222-4222-8222-222222222222";
const C = "cccccccc-3333-4333-8333-333333333333";

let home: string;
beforeEach(() => {
  home = tmpHome("cad-");
});
const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
  fs.rmSync(home, { recursive: true, force: true });
});

/** Copy the fixture ~/.claude into a temp dir and give transcripts known ages (git drops mtimes). */
function claudeHome(): { projects: string; sessions: string } {
  const root = path.join(home, "cc");
  fs.cpSync(FIXTURE, root, { recursive: true });
  fs.mkdirSync(path.join(root, "sessions"), { recursive: true });
  const now = Date.now() / 1000;
  const age: Record<string, number> = { [A]: 3600, [B]: 600, [C]: 5 };
  for (const d of fs.readdirSync(path.join(root, "projects")))
    for (const f of fs.readdirSync(path.join(root, "projects", d))) {
      const id = f.replace(".jsonl", "");
      const t = now - (age[id] ?? 100);
      fs.utimesSync(path.join(root, "projects", d, f), t, t);
    }
  return { projects: path.join(root, "projects"), sessions: path.join(root, "sessions") };
}

const sess = (id: string, cwd = "/Users/dev/alpha"): ClaudeSession => ({
  id, file: "/x.jsonl", cwd, updatedAt: new Date().toISOString(), size: 10, firstPrompt: "p", title: null, gitBranch: null, livePid: null,
});
const noLive: LiveClaudes = { bySession: new Map(), unmatched: [] };
const openCtx: SignalContext = { protectedPids: new Set([1000, 999]), supervisedPids: new Set([4243]) };

describe("transcript discovery (fixtures, never the real ~/.claude)", () => {
  it("lists conversations across projects, newest first, with cwd, prompt, title and size", () => {
    const cc = claudeHome();
    const all = listAllClaudeSessions({ projectsRoot: cc.projects, sessionsDir: cc.sessions });
    expect(all.map((s) => s.id)).toEqual([C, B, A]); // d… has no prompt, e… is empty, notes.jsonl isn't a UUID
    expect(all[0]).toMatchObject({ cwd: "/Users/dev/beta", firstPrompt: "Write the release notes" });
    expect(all[1]).toMatchObject({ cwd: "/Users/dev/alpha", firstPrompt: "Add retries to the uploader", title: "Uploader retries" });
    expect(all[2].gitBranch).toBe("main");
    expect(all[2].size).toBeGreaterThan(100);
  });

  it("limit, id prefix and only filters", () => {
    const cc = claudeHome();
    expect(listAllClaudeSessions({ projectsRoot: cc.projects, sessionsDir: cc.sessions, limit: 2 })).toHaveLength(2);
    expect(listAllClaudeSessions({ projectsRoot: cc.projects, sessionsDir: cc.sessions, id: "aaaa" }).map((s) => s.id)).toEqual([A]);
    expect(listAllClaudeSessions({ projectsRoot: cc.projects, sessionsDir: cc.sessions, only: new Set([B]) }).map((s) => s.id)).toEqual([B]);
  });

  it("never writes to the transcripts it reads", () => {
    const cc = claudeHome();
    const f = path.join(cc.projects, "-Users-dev-alpha", `${A}.jsonl`);
    const before = fs.statSync(f).mtimeMs;
    const text = fs.readFileSync(f, "utf8");
    listAllClaudeSessions({ projectsRoot: cc.projects, sessionsDir: cc.sessions });
    expect(fs.statSync(f).mtimeMs).toBe(before);
    expect(fs.readFileSync(f, "utf8")).toBe(text);
  });

  it("a missing projects folder is just empty", () => {
    expect(listAllClaudeSessions({ projectsRoot: path.join(home, "nope") })).toEqual([]);
  });
});

describe("live-process matching", () => {
  it("parses ps and recognises claude CLIs only", () => {
    const ps = parsePs(
      [
        "  101     1 /Users/u/.local/bin/claude --settings {}",
        "  102     1 /Users/u/.local/share/claude/versions/2.1.325 --resume x",
        "  103     1 /Users/u/.local/bin/claude --chrome-native-host",
        "  104     1 node /usr/local/bin/csuper",
        "  105     1 /usr/bin/vim claude.md",
      ].join("\n"),
    );
    expect(ps.filter((p) => isClaudeCommand(p.args)).map((p) => p.pid)).toEqual([101, 102]);
    expect(parseLsofCwd("p101\nfcwd\nn/Users/dev/alpha\np102\nfcwd\nn/Users/dev/beta\n")).toEqual(
      new Map([
        [101, "/Users/dev/alpha"],
        [102, "/Users/dev/beta"],
      ]),
    );
  });

  it("registry gives exact matches; unregistered claudes become 'possibly live' for their cwd", () => {
    const cc = claudeHome();
    // process.pid stands in for a live claude that registered conversation A.
    fs.writeFileSync(path.join(cc.sessions, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: A, cwd: "/Users/dev/alpha" }));
    fs.writeFileSync(path.join(cc.sessions, `999999.json`), JSON.stringify({ pid: 999999, sessionId: B, cwd: "/x" })); // dead pid
    const live = detectLiveClaudes({
      sessionsDir: cc.sessions,
      scan: () => [
        { pid: process.pid, ppid: 1, cwd: "/Users/dev/alpha" },
        { pid: 7001, ppid: 1, cwd: "/Users/dev/beta" },
      ],
    });
    expect(live.bySession).toEqual(new Map([[A, process.pid]]));
    expect(live.unmatched.map((p) => p.pid)).toEqual([7001]);
    expect(classifySession(sess(A), live, [])).toMatchObject({ status: "live", pid: process.pid });
    expect(classifySession(sess(B), live, [])).toMatchObject({ status: "ended", pid: null });
    expect(classifySession(sess(C, "/Users/dev/beta"), live, [])).toMatchObject({ status: "possibly live", pid: 7001 });
  });

  it("falls back to the process scan when the registry is missing or unreadable", () => {
    const missing = detectLiveClaudes({ sessionsDir: path.join(home, "no-such-dir"), scan: () => [{ pid: 7002, ppid: 1, cwd: "/w" }] });
    expect(missing.bySession.size).toBe(0);
    expect(missing.unmatched.map((p) => p.pid)).toEqual([7002]);
    const dir = path.join(home, "s");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "1.json"), "{not json");
    expect(() => detectLiveClaudes({ sessionsDir: dir, scan: () => [] })).not.toThrow();
  });

  it("'already csuper' from claude_pid or the recorded conversation", () => {
    const live: LiveClaudes = { bySession: new Map([[A, process.pid]]), unmatched: [] };
    expect(classifySession(sess(A), live, [{ csuperId: "a1b2c3", claudePid: process.pid, claudeSessionId: null }])).toMatchObject({
      status: "already csuper",
      csuperId: "a1b2c3",
    });
    expect(classifySession(sess(B), noLive, [{ csuperId: "d4e5f6", claudePid: process.pid, claudeSessionId: B }])).toMatchObject({
      status: "already csuper",
    });
  });
});

describe("refusal and confirmation logic", () => {
  const c = (status: any, pid: number | null, candidates = pid ? [pid] : []) => ({ status, pid, csuperId: status === "already csuper" ? "a1b2c3" : null, candidates });

  it("ended → adopt", () => {
    expect(planItem(sess(A), c("ended", null), {}, openCtx).action).toBe("adopt");
  });
  it("live without --stop-original → refused with how to fix it", () => {
    const p = planItem(sess(A), c("live", 5000), {}, openCtx);
    expect(p.action).toBe("refuse");
    expect(p.reason).toMatch(/still open in claude \(pid 5000\)/);
    expect(p.reason).toMatch(/--stop-original/);
    expect(p.reason).toMatch(/--fork/);
  });
  it("live with --stop-original → stop then adopt", () => {
    expect(planItem(sess(A), c("live", 5000), { stopOriginal: true }, openCtx)).toMatchObject({ action: "stop-then-adopt", pid: 5000 });
  });
  it("--fork never stops anything", () => {
    expect(planItem(sess(A), c("live", 5000), { fork: true, stopOriginal: true }, openCtx).action).toBe("adopt");
  });
  it("already csuper → refused, even with --stop-original", () => {
    expect(planItem(sess(A), c("already csuper", 4243), { stopOriginal: true }, openCtx).action).toBe("refuse");
  });
  it("possibly live with several candidate claudes → refused (can't tell which)", () => {
    const p = planItem(sess(A), c("possibly live", null, [7001, 7002]), { stopOriginal: true }, openCtx);
    expect(p.action).toBe("refuse");
    expect(p.reason).toMatch(/7001, 7002/);
  });
  it("won't plan to stop an ancestor or a supervised claude", () => {
    expect(planItem(sess(A), c("live", 999), { stopOriginal: true }, openCtx)).toMatchObject({ action: "refuse" });
    expect(planItem(sess(A), c("live", 999), { stopOriginal: true }, openCtx).reason).toMatch(/ancestor/);
    expect(planItem(sess(A), c("possibly live", 4243), { stopOriginal: true }, openCtx).reason).toMatch(/already supervised/);
  });
});

describe("signal guard", () => {
  it("never signals itself, its ancestors, or a csuper-supervised claude", () => {
    const tree = new Map([
      [500, 400],
      [400, 300],
      [300, 1],
    ]);
    expect([...ancestorsOf(500, tree)]).toEqual([500, 400, 300]);
    const ctx: SignalContext = { protectedPids: ancestorsOf(500, tree), supervisedPids: new Set([800]) };
    expect(checkSignalTarget(process.pid, ctx).ok).toBe(false);
    expect(checkSignalTarget(400, ctx)).toMatchObject({ ok: false, reason: expect.stringMatching(/ancestor/) });
    expect(checkSignalTarget(800, ctx)).toMatchObject({ ok: false, reason: expect.stringMatching(/already supervised/) });
    expect(checkSignalTarget(1, ctx).ok).toBe(false);
    expect(checkSignalTarget(0, ctx).ok).toBe(false);
    expect(checkSignalTarget(600, ctx).ok).toBe(true);
  });

  it("the real context protects this process and its parent chain", () => {
    const ctx = signalContext({ csuperSessionsDir: path.join(home, "none") });
    expect(ctx.protectedPids.has(process.pid)).toBe(true);
    expect(ctx.protectedPids.has(process.ppid)).toBe(true);
  });

  it("reads supervised claude pids from ~/.csuper/sessions/*.json", () => {
    const dir = path.join(home, "sessions");
    const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 30000)"]);
    children.push(child);
    writeSessionInfo({ id: "a1b2c3", pid: process.pid, claude_pid: child.pid!, cwd: "/p", started_at: "x", config_path: null, version: "t", claude_session_id: A }, dir);
    writeSessionInfo({ id: "d4e5f6", pid: 999999, claude_pid: 999998, cwd: "/p", started_at: "x", config_path: null, version: "t" }, dir); // dead
    expect(supervisedClaudes(dir)).toEqual([{ csuperId: "a1b2c3", claudePid: child.pid, claudeSessionId: A }]);
    expect(signalContext({ csuperSessionsDir: dir }).supervisedPids.has(child.pid!)).toBe(true);
  });

  it("stopOriginal refuses a protected pid without sending any signal", async () => {
    const kill = vi.fn();
    const r = await stopOriginal({ pid: 999, transcript: "/x", registryFile: null, timeoutMs: 500, ctx: openCtx, kill });
    expect(r.ok).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });
});

describe("stop sequence (SIGTERM, wait, never SIGKILL)", () => {
  /** A stand-in claude: keeps a registry file, writes the transcript, cleans up on SIGTERM. */
  function fakeClaude(onTerm: "exit" | "ignore", registry: string, transcript: string): Promise<ChildProcess> {
    const src = `
      const fs = require("fs");
      fs.writeFileSync(${JSON.stringify(registry)}, "{}");
      process.on("SIGTERM", () => {
        ${onTerm === "exit" ? `fs.appendFileSync(${JSON.stringify(transcript)}, "bye\\n"); fs.unlinkSync(${JSON.stringify(registry)}); process.exit(143);` : ""}
      });
      console.log("up");
      setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ["-e", src], { stdio: ["ignore", "pipe", "ignore"] });
    children.push(child);
    return new Promise((r) => child.stdout!.once("data", () => r(child)));
  }
  const ctx = (): SignalContext => ({ protectedPids: new Set([process.pid]), supervisedPids: new Set() });

  it("waits for exit, registry removal and a quiet transcript", async () => {
    const reg = path.join(home, "reg.json");
    const tr = path.join(home, "t.jsonl");
    fs.writeFileSync(tr, "hi\n");
    const child = await fakeClaude("exit", reg, tr);
    const r = await stopOriginal({ pid: child.pid!, transcript: tr, registryFile: reg, timeoutMs: 5000, ctx: ctx(), quietMs: 300 });
    expect(r.ok).toBe(true);
    expect(fs.existsSync(reg)).toBe(false);
    expect(fs.readFileSync(tr, "utf8")).toBe("hi\nbye\n");
  });

  it("times out and reports, leaving the process alive (no SIGKILL)", async () => {
    const reg = path.join(home, "reg.json");
    const tr = path.join(home, "t.jsonl");
    fs.writeFileSync(tr, "");
    const child = await fakeClaude("ignore", reg, tr);
    const sigs: string[] = [];
    const r = await stopOriginal({
      pid: child.pid!,
      transcript: tr,
      registryFile: reg,
      timeoutMs: 800,
      ctx: ctx(),
      kill: (pid, sig) => {
        sigs.push(sig);
        process.kill(pid, sig);
      },
    });
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/timed out.*still running.*Not sending SIGKILL/) });
    expect(sigs).toEqual(["SIGTERM"]);
    expect(child.exitCode).toBeNull();
    expect(() => process.kill(child.pid!, 0)).not.toThrow();
  });
});

describe("registry adoptedFrom", () => {
  it("round-trips through ~/.csuper/sessions/<id>.json", () => {
    const dir = path.join(home, "sessions");
    const adoptedFrom = { claudeSessionId: A, adoptedAt: "2026-11-14T07:30:00.000Z", stoppedPid: 4242, resumedSessionId: null };
    writeSessionInfo({ id: "a1b2c3", pid: 1, claude_pid: 2, cwd: "/p", started_at: "x", config_path: null, version: "t", adoptedFrom }, dir);
    expect(readSessionInfo("a1b2c3", dir)?.adoptedFrom).toEqual(adoptedFrom);
  });
});

describe("config schema", () => {
  it("adopt: defaults and the YAML file are in sync", () => {
    const yaml = YAML.parse(fs.readFileSync(path.resolve(__dirname, "..", "csuper.config.yaml"), "utf8"));
    expect(Object.keys(yaml.adopt).sort()).toEqual(Object.keys(defaultConfig().adopt).sort());
    expect(parseConfig(fs.readFileSync(path.resolve(__dirname, "..", "csuper.config.yaml"), "utf8")).adopt).toEqual({
      default_autopilot: false,
      default_open_mode: "tabs",
      compact_on_adopt: false,
      stop_wait_timeout_ms: 10000,
      scan_limit: 50,
    });
  });
  it("rejects unknown keys and bad values", () => {
    expect(() => parseConfig("adopt:\n  default_open_mode: window\n")).toThrow();
    expect(() => parseConfig("adopt:\n  nope: 1\n")).toThrow();
    expect(() => parseConfig("adopt:\n  scan_limit: 0\n")).toThrow();
  });
});

describe("CLI flags, open mode, tabs, summary", () => {
  it("resume keeps its flags and means adopt --here in this folder", () => {
    expect(parseAdoptArgv(["cccc", "--fork", "--", "--model", "opus"], true)).toMatchObject({
      ids: ["cccc"], fork: true, claudeArgs: ["--model", "opus"], resumeMode: true,
    });
    expect(parseAdoptArgv(["--list"], true)).toMatchObject({ list: true, ids: [] });
    expect(parseAdoptArgv(["a", "b"], true)).toHaveProperty("error");
    expect(parseAdoptArgv(["--tabs"], true)).toHaveProperty("error");
    expect(openModeFor(1, { resumeMode: true, tabs: false }, defaultConfig().adopt)).toEqual({ mode: "here", explicit: true });
  });
  it("adopt flag combinations", () => {
    expect(parseAdoptArgv(["--latest", "--all-live"], false)).toHaveProperty("error");
    expect(parseAdoptArgv(["--autopilot", "--paused"], false)).toHaveProperty("error");
    expect(parseAdoptArgv(["x", "--stop-original", "--dry-run", "--stopped-pid", "42"], false)).toMatchObject({ stopOriginal: true, dryRun: true, stoppedPid: 42 });
  });
  it("--here only for one session; several default to tabs", () => {
    const cfg = defaultConfig().adopt;
    expect(openModeFor(3, { here: true }, cfg)).toHaveProperty("error");
    expect(openModeFor(3, {}, cfg)).toEqual({ mode: "tabs", explicit: false });
    expect(openModeFor(1, { here: true }, cfg)).toEqual({ mode: "here", explicit: true });
    expect(openModeFor(1, {}, { ...cfg, default_open_mode: "here" })).toEqual({ mode: "here", explicit: false });
  });
  it("unsupported terminals get a clear error suggesting --here", () => {
    expect(tabLauncher({ TERM_PROGRAM: "vscode" })).toEqual({ error: expect.stringMatching(/"vscode".*--here/) });
    expect(tabLauncher({})).toHaveProperty("error");
    expect(tabLauncher({ TERM_PROGRAM: "iTerm.app" })).toHaveProperty("open");
    expect(tabLauncher({ TERM_PROGRAM: "Apple_Terminal" })).toHaveProperty("open");
  });
  it("tab command runs adopt --here in the conversation's folder, quoting safely", () => {
    const cmd = tabCommand({
      cwd: "/Users/dev/my proj",
      id: A,
      csuper: ["/usr/bin/node", "/opt/csuper.js"],
      autopilot: false,
      compact: true,
      fork: false,
      stoppedPid: 4242,
      claudeArgs: ["--model", "it's"],
      env: { CSUPER_HOME: "/h", PATH: "/bin" },
      configPath: "/c.yaml",
    });
    expect(cmd).toBe(
      `cd '/Users/dev/my proj' && env CSUPER_HOME=/h CSUPER_CONFIG=/c.yaml /usr/bin/node /opt/csuper.js adopt ${A} --here --paused --compact --stopped-pid 4242 -- --model 'it'\\''s'`,
    );
    expect(shq("a b")).toBe("'a b'");
  });
  it("summary table lists session, project, csuper id and result", () => {
    const t = summaryTable([
      { session: "aaaaaaaa", project: "~/alpha", result: "adopted in a new Terminal tab", csuper: "a1b2c3" },
      { session: "bbbbbbbb", project: "~/beta", result: "refused (live): still open", csuper: "—" },
    ]);
    expect(t.split("\n")).toHaveLength(3);
    expect(t).toMatch(/^SESSION\s+PROJECT\s+CSUPER\s+RESULT/);
    expect(t).toMatch(/aaaaaaaa\s+~\/alpha\s+a1b2c3\s+adopted/);
  });
});
