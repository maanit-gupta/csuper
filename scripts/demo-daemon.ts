/**
 * Demo daemon: simulates a csuper supervisor session so the dashboard and one-shot
 * commands can be tried without the PTY supervisor. It registers a session, serves
 * the IPC socket, writes JSONL logs and mutates state over time.
 *
 *   npm run demo            # terminal 1
 *   csuper dash             # terminal 2
 *
 * Options (used by the e2e suite):
 *   --id <6-hex>       reuse a session ID, e.g. to "restart" the same session
 *   --scenario <name>  ok (default, simulated activity) | paused | waiting | anomaly
 *                      — anything but ok starts in that state and stays there
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { IpcServer } from "../src/ipc-server.js";
import { localIsoString, Logger } from "../src/logger.js";
import { ensureHome, logsDir } from "../src/paths.js";
import { isValidSessionId, newSessionId, removeSession, sockPathFor, writeSessionInfo } from "../src/session-registry.js";
import { initialState } from "../src/state.js";

const { values: args } = parseArgs({ options: { id: { type: "string" }, scenario: { type: "string", default: "ok" } } });
const scenario = args.scenario!;
if (!["ok", "paused", "waiting", "anomaly"].includes(scenario)) throw new Error(`unknown --scenario ${scenario}`);
if (args.id !== undefined && !isValidSessionId(args.id)) throw new Error(`--id must be 6 hex chars`);

ensureHome();
const id = args.id ?? newSessionId();
const cwd = process.cwd();
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
const logger = new Logger({ session: id, file: path.join(logsDir(), `${id}.jsonl`) });

const handoverDir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "csuper-demo-"));
const handoverPath = path.join(handoverDir, "handover.md");
fs.writeFileSync(
  handoverPath,
  ["# Handover", "", "## Done", "- Session registry + tests", "- JSONL logger with rotation", "", "## Next", "- IPC fan-out", "- TUI panels", "", "## Notes", "- Keep hooks zero-dependency"].join("\n"),
);

const state = initialState({ id, cwd, pid: process.pid, claudePid: process.pid, startedAt: new Date().toISOString(), version: "0.1.0-demo" });
state.cycles = { ...state.cycles, used: 0, max: 20 };
state.activeHours = { window: "00:00-23:59", inside: true };
state.anomalies.threshold = 5;
state.rateLimit = { ...state.rateLimit, sessionResetAt: iso(3 * 3600e3), weeklyResetAt: iso(4 * 86400e3), weeklyStopPct: 90, caffeinatePid: process.pid };
state.handover = { path: handoverPath, mtime: new Date().toISOString() };
if (scenario === "paused") state.autopilot = { enabled: false, pausedReason: "user" };
if (scenario === "anomaly") {
  state.autopilot = { enabled: false, pausedReason: "anomaly" };
  state.anomalies.last = { kind: "tool_failure_streak", ts: localIsoString(), actions: ["git stash", "/clear"] };
}
if (scenario === "waiting") state.rateLimit = { ...state.rateLimit, status: "waiting", resumeAt: iso(10 * 60e3) };

const server = new IpcServer({
  sockPath: sockPathFor(id),
  initialState: state,
  logger,
  onHookMessage: (m) => logger.debug("hook.error", "demo received hook message", { m: m as any }),
  onControl: (action) => {
    const s = server.getState();
    switch (action) {
      case "autopilot.pause":
        if (!s.autopilot.enabled) return { ok: false, error: "already paused" };
        server.patchState({ autopilot: { enabled: false, pausedReason: "user" } });
        logger.info("autopilot.toggled", "autopilot paused from dashboard");
        return { ok: true };
      case "autopilot.resume":
        if (s.autopilot.enabled) return { ok: false, error: "already running" };
        server.patchState({ autopilot: { enabled: true, pausedReason: null } });
        logger.info("autopilot.toggled", "autopilot resumed from dashboard");
        return { ok: true };
      case "countdown.cancel":
        if (!s.countdown) return { ok: false, error: "no countdown pending" };
        server.patchState({ countdown: null, cycles: { current: null } });
        logger.info("countdown.cancelled", "countdown cancelled from dashboard");
        return { ok: true };
      case "ratelimit.skip_wait":
        if (s.rateLimit.status !== "waiting") return { ok: false, error: "not waiting on a rate limit" };
        server.patchState({ rateLimit: { status: "ok", resumeAt: null } });
        logger.warn("ratelimit.resumed", "resume_prompt sent early (skip-wait)");
        return { ok: true };
    }
  },
});

await server.listen();
writeSessionInfo({ id, pid: process.pid, claude_pid: process.pid, cwd, started_at: state.session.startedAt, config_path: null, version: "0.1.0-demo" });
logger.info("session.start", `demo session ${id} started`, { cwd });
process.stdout.write(`demo session ${id} — socket ${sockPathFor(id)}\nCtrl+C to stop\n`);

let tick = 0;
const timer = setInterval(() => {
  tick++;
  if (scenario !== "ok") return;
  const s = server.getState();
  if (!s.autopilot.enabled) return;
  if (s.countdown && Date.parse(s.countdown.firesAt) <= Date.now()) {
    for (const c of s.countdown.commands) logger.info("command.injected", c);
    const cur = s.cycles.current;
    const rec = {
      id: cur?.id ?? s.cycles.used + 1,
      trigger: "task_complete",
      startedAt: cur?.startedAt ?? localIsoString(),
      endedAt: new Date().toISOString(),
      durationMs: cur ? Date.now() - Date.parse(cur.startedAt) : 0,
      result: "ok" as const,
      step: null,
      reason: null,
      phase: `${s.cycles.used + 2}: Demo phase`,
    };
    server.patchState({ countdown: null, cycles: { used: s.cycles.used + 1, lastOkAt: rec.endedAt, current: null, recent: [...s.cycles.recent, rec].slice(-10) } });
    server.patchState({ git: { lastCheckpoint: { sha: Math.random().toString(16).slice(2, 9), ts: localIsoString(), files: 1 + (tick % 6) } } });
    logger.info("git.checkpoint", "chore(csuper): checkpoint");
  }
  if (tick % 9 === 0 && !s.countdown && s.rateLimit.status === "ok") {
    const t = { name: "task_complete", keyword: "::DONE::", ts: localIsoString(), commands: ["/clear", "/next"] };
    const n = s.cycles.used + s.cycles.failed + 1;
    const current = { id: n, trigger: t.name, startedAt: localIsoString(), step: 2, total: 8, name: "countdown", label: "countdown", stepStartedAt: localIsoString(), deadline: null };
    server.patchState({ triggers: { recent: [...s.triggers.recent, t].slice(-20) }, countdown: { trigger: t.name, firesAt: iso(5000), commands: t.commands }, cycles: { current } });
    server.emitEvent("trigger.matched", t);
    logger.info("trigger.matched", "::DONE:: matched (last_line)", { trigger: t.name, commands: t.commands });
    logger.info("countdown.started", "pre_clear_delay_ms countdown started", { ms: 5000 });
  }
  if (tick % 7 === 0) {
    const streak = (s.anomalies.toolFailureStreak + 1) % 4;
    server.patchState({ anomalies: { toolFailureStreak: streak } });
    logger.log(streak >= 3 ? "warn" : "debug", "hook.error", `tool failure streak ${streak}`);
  }
  if (tick === 40) {
    server.patchState({ rateLimit: { status: "waiting", reason: "5-hour limit", source: "hook", resetAt: iso(5 * 60e3), resumeAt: iso(5 * 60e3 + 60e3), waitStartedAt: localIsoString() } });
    logger.warn("ratelimit.detected", "5-hour limit reached");
    logger.info("ratelimit.resume_scheduled", "resume scheduled", { margin_s: 60 });
  }
}, 1000);

const shutdown = async () => {
  clearInterval(timer);
  logger.info("session.end", "demo session ended");
  await server.close();
  removeSession(id);
  fs.rmSync(handoverDir, { recursive: true, force: true });
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
