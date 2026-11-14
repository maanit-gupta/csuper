/**
 * Core PTY supervisor: runs `claude` in a pseudo-terminal, passes the terminal through
 * unchanged, and publishes the session to `csuper dash` / `status` / `ctl`.
 *
 * What it does:
 *   - session registry + IPC socket + JSONL log (same pieces the dashboard reads)
 *   - Ctrl+G and `csuper ctl pause|resume` toggle autopilot
 *   - Claude Code hooks (injected with `claude --settings`) report tool results
 *     (tool-failure streak, edit thrash) and drive the autopilot engine
 *     (./autopilot.ts): keyword triggers, the checked /clear → /next cycle, usage-limit
 *     waits with automatic resume, model failover, git checkpoints
 *   - `--resume <uuid>` to take over an existing Claude Code conversation
 *
 * Nothing here writes to stdout while claude runs: stdout belongs to the PTY.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IPty } from "node-pty";
import { loadConfig, type Config, defaultConfig } from "../config.js";
import { IpcServer, type ControlResult } from "../ipc-server.js";
import { Logger } from "../logger.js";
import { ensureHome, logsDir } from "../paths.js";
import type { ControlAction } from "../protocol.js";
import { newSessionId, removeSession, sockPathFor, writeSessionInfo, type AdoptedFrom, type SessionInfo } from "../session-registry.js";
import { initialState, type DashState } from "../state.js";
import { Autopilot, type HookMsg } from "./autopilot.js";
import { claudeChildEnv } from "./child-env.js";
import { Caffeinate, gitCheckpoint, notifyMac, sampleWriter, saveHandover } from "./host.js";
import { insideActiveHours } from "./limits.js";
import { claudeRegistryFile, readClaudeRegistry } from "./claude-sessions.js";

export interface SuperviseOptions {
  /** Arguments passed through to claude. */
  claudeArgs: string[];
  /** Claude Code conversation to resume (UUID). */
  resumeId?: string | null;
  /** With resumeId: resume into a new conversation ID (claude --fork-session). */
  fork?: boolean;
  version: string;
  /** Folder to run claude in (default: process.cwd()). */
  cwd?: string;
  /** Start with autopilot on (default true; `csuper adopt` starts paused). */
  autopilot?: boolean;
  /** Send /compact once claude is ready. */
  compact?: boolean;
  /** Recorded in the registry when this session was adopted. */
  adoptedFrom?: AdoptedFrom | null;
}

const CTRL_G = 0x07;
/** Edits to the same file within this window count toward edit thrash. */
const THRASH_WINDOW_MS = 10 * 60_000;

/** Locate the hook script both in dist/ (bundled) and when run from source. */
export function hookScriptPath(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const p of [path.join(here, "hooks", "csuper-hook.js"), path.join(here, "..", "..", "hooks", "csuper-hook.js")]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Tool events: matched by tool name. */
export const TOOL_HOOK_EVENTS = ["PostToolUse", "PostToolUseFailure"] as const;
/**
 * Lifecycle events the autopilot engine listens to (all present in Claude Code 2.1.325):
 * Stop (final message → triggers), SessionStart (source "clear" confirms /clear),
 * UserPromptSubmit / UserPromptExpansion (a command started a turn), StopFailure and
 * Notification (usage limits), PostModelSwitch (confirms /model).
 */
export const LIFECYCLE_HOOK_EVENTS = ["Stop", "StopFailure", "SessionStart", "UserPromptSubmit", "UserPromptExpansion", "Notification", "PostModelSwitch"] as const;

/** The `--settings` JSON that registers csuper's hook for this claude only. */
export function hookSettings(nodeBin: string, hookPath: string): string {
  const cmd = `${JSON.stringify(nodeBin)} ${JSON.stringify(hookPath)}`;
  const handler = { type: "command", command: cmd, timeout: 5 };
  const hooks: Record<string, unknown> = {};
  for (const e of TOOL_HOOK_EVENTS) hooks[e] = [{ matcher: "*", hooks: [handler] }];
  // No matcher = every source / notification type / error kind.
  for (const e of LIFECYCLE_HOOK_EVENTS) hooks[e] = [{ hooks: [handler] }];
  return JSON.stringify({ hooks });
}

/** Build claude's argv: resume flags, our hook settings, then the user's own args. */
export function buildClaudeArgs(o: { claudeArgs: string[]; resumeId?: string | null; fork?: boolean; settings: string | null }): string[] {
  const userHasSettings = o.claudeArgs.some((a) => a === "--settings" || a.startsWith("--settings="));
  const args: string[] = [];
  if (o.resumeId) args.push("--resume", o.resumeId);
  if (o.resumeId && o.fork) args.push("--fork-session");
  if (o.settings && !userHasSettings) args.push("--settings", o.settings);
  return [...args, ...o.claudeArgs];
}

/** `--model x` / `--model=x` from claude's args, for the Session panel. */
export function modelFromArgs(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--model" && args[i + 1]) return args[i + 1];
    if (args[i].startsWith("--model=")) return args[i].slice(8);
  }
  return null;
}

/** First executable `name` on PATH. */
export function which(name: string, envPath = process.env.PATH ?? ""): string | null {
  if (name.includes("/")) return fs.existsSync(name) ? path.resolve(name) : null;
  for (const dir of envPath.split(":")) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (fs.statSync(p).isFile()) return p;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/**
 * node-pty's prebuilt `spawn-helper` ships without the executable bit when npm skips
 * install scripts (npm 11 allow-scripts), which makes every spawn fail with
 * "posix_spawnp failed". Fix it in place; harmless when it's already executable.
 */
export function ensureSpawnHelper(ptyDir: string): void {
  const candidates = [
    path.join(ptyDir, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
    path.join(ptyDir, "build", "Release", "spawn-helper"),
  ];
  for (const p of candidates) {
    try {
      const st = fs.statSync(p);
      if ((st.mode & 0o111) !== 0o111) fs.chmodSync(p, st.mode | 0o755);
    } catch {
      /* not present or not ours to change */
    }
  }
}

async function loadPty(): Promise<typeof import("node-pty")> {
  const require = createRequire(import.meta.url);
  const entry = require.resolve("node-pty");
  ensureSpawnHelper(path.resolve(path.dirname(entry), ".."));
  return (await import("node-pty")) as typeof import("node-pty");
}

/** Called before the PTY starts, so it may still write to stderr. */
function quietConfig(): { config: Config; path: string | null } {
  try {
    return loadConfig();
  } catch (e) {
    process.stderr.write(`csuper: invalid config, using built-in defaults (${(e as Error).message.split("\n")[0]})\n`);
    return { config: defaultConfig(), path: null };
  }
}

/** The session's starting state, with the configured circuit-breaker limits filled in. */
export function sessionInitialState(config: Config, session: DashState["session"], claudeArgs: string[], autopilot = true): DashState {
  const state = initialState(session);
  state.model = modelFromArgs(claudeArgs) ?? "default";
  const cb = config.rate_limits.circuit_breakers;
  state.cycles.max = cb.max_auto_cycles_per_session;
  state.rateLimit.weeklyStopPct = cb.weekly_quota_stop_pct;
  state.activeHours = { window: cb.active_hours, inside: insideActiveHours(cb.active_hours) };
  state.anomalies.threshold = config.anomalies.max_consecutive_tool_failures;
  if (!autopilot) state.autopilot = { enabled: false, pausedReason: "user" };
  return state;
}

/** True when a tool-failure streak has just reached the configured threshold. */
export function toolFailureBreakerTrips(streak: number, threshold: number): boolean {
  return threshold > 0 && streak >= threshold;
}

const say = (msg: string) => process.stderr.write(`\x1b[2mcsuper:\x1b[22m ${msg}\n`);

export async function runSupervisor(opts: SuperviseOptions): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write("csuper: the supervisor needs an interactive terminal\n");
    return 64;
  }
  const claudeBin = which(process.env.CSUPER_CLAUDE_BIN || "claude");
  if (!claudeBin) {
    process.stderr.write("csuper: `claude` not found on PATH (set CSUPER_CLAUDE_BIN to its path)\n");
    return 127;
  }
  let pty: typeof import("node-pty");
  try {
    pty = await loadPty();
  } catch (e) {
    process.stderr.write(`csuper: node-pty failed to load: ${(e as Error).message}\nSee INSTALL.md → Troubleshooting → node-pty.\n`);
    return 70;
  }

  const { config, path: configPath } = quietConfig();
  ensureHome();
  const id = newSessionId();
  const sockPath = sockPathFor(id);
  const cwd = opts.cwd ?? process.cwd();
  const logger = new Logger({
    session: id,
    file: path.join(logsDir(), `${id}.jsonl`),
    maxBytes: config.general.log_max_bytes,
    keepFiles: config.general.log_keep_files,
  });
  const startedAt = new Date().toISOString();
  const state = sessionInitialState(
    config,
    { id, cwd, pid: process.pid, claudePid: 0, startedAt, version: opts.version, adoptedFrom: opts.adoptedFrom?.claudeSessionId ?? null },
    opts.claudeArgs,
    opts.autopilot ?? true,
  );

  const hookPath = hookScriptPath();
  const args = buildClaudeArgs({
    claudeArgs: opts.claudeArgs,
    resumeId: opts.resumeId,
    fork: opts.fork,
    settings: hookPath ? hookSettings(process.execPath, hookPath) : null,
  });

  // Set once the PTY exists; the engine only types into claude through it.
  let child: IPty | null = null;
  let lastOutput = Date.now();
  const caffeinate = new Caffeinate();
  const autopilot = new Autopilot(
    {
      write: (d) => child?.write(d),
      getState: () => server.getState(),
      patch: (p) => server.patchState(p),
      log: logger,
      notify: notifyMac,
      startCaffeinate: () => caffeinate.start(),
      stopCaffeinate: () => {
        if (caffeinate.pid) logger.info("caffeinate.stopped", `caffeinate stopped (pid ${caffeinate.pid})`);
        caffeinate.stop();
      },
      gitCheckpoint: async (trigger) => {
        const cp = await gitCheckpoint(cwd, trigger);
        if (cp) logger.info("git.checkpoint", `chore(csuper): checkpoint ${cp.sha} (${cp.files} files)`, cp);
        else logger.debug("git.checkpoint", "no checkpoint: tree clean or not a git repo");
        return cp;
      },
      saveHandover: (text, trigger) => saveHandover(cwd, text, trigger),
      saveSample: sampleWriter(id),
      lastOutputAt: () => lastOutput,
    },
    config,
  );

  // Edit-thrash bookkeeping: per-file edit timestamps inside the window.
  const edits = new Map<string, number[]>();
  const rel = (f: string) => (f.startsWith(cwd + path.sep) ? f.slice(cwd.length + 1) : f);

  const server: IpcServer = new IpcServer({
    sockPath,
    initialState: state,
    logger,
    maxBufferedMsgs: config.general.subscriber_buffer_msgs,
    onControl: (action) => control(action, "dashboard"),
    onHookMessage: (raw) => {
      const m = raw as { type?: string; event?: string; tool?: string | null; ok?: boolean; file?: string | null; error?: string | null; claude_session_id?: string | null };
      if (!m || m.type !== "hook") return;
      if (m.event !== "PostToolUse" && m.event !== "PostToolUseFailure") return autopilot.onHook(raw as HookMsg);
      autopilot.onHook(raw as HookMsg);
      const s = server.getState();
      if (m.ok === false) {
        const streak = s.anomalies.toolFailureStreak + 1;
        server.patchState({ anomalies: { toolFailureStreak: streak } });
        logger.warn("tool.failed", `${m.tool ?? "tool"} failed (streak ${streak})`, { tool: m.tool ?? null, error: m.error ?? null, streak });
        const threshold = s.anomalies.threshold;
        if (toolFailureBreakerTrips(streak, threshold) && s.autopilot.pausedReason !== "breaker") {
          server.patchState({ autopilot: { enabled: false, pausedReason: "breaker" } });
          logger.error("breaker.tripped", `${streak} consecutive tool failures (limit ${threshold}); autopilot paused`, { streak, threshold });
        }
      } else if (s.anomalies.toolFailureStreak !== 0) {
        server.patchState({ anomalies: { toolFailureStreak: 0 } });
      }
      if (m.ok !== false && m.file && /^(Edit|MultiEdit|Write|NotebookEdit)$/.test(m.tool ?? "")) {
        const now = Date.now();
        const f = rel(m.file);
        edits.set(f, [...(edits.get(f) ?? []), now].filter((t) => now - t < THRASH_WINDOW_MS));
        const thrash: Record<string, number> = {};
        for (const [file, ts] of edits) {
          const recent = ts.filter((t) => now - t < THRASH_WINDOW_MS);
          if (recent.length === 0) edits.delete(file);
          else if (recent.length >= 2) thrash[file] = recent.length;
        }
        server.patchState({ anomalies: { editThrash: thrash } });
      }
    },
  });

  function control(action: ControlAction, from: "dashboard" | "keyboard"): ControlResult {
    const s = server.getState();
    switch (action) {
      case "autopilot.pause":
        if (!s.autopilot.enabled) return { ok: false, error: "already paused" };
        server.patchState({ autopilot: { enabled: false, pausedReason: "user" } });
        logger.info("autopilot.toggled", `autopilot paused (${from})`, { enabled: false, from });
        autopilot.onAutopilotChanged(false);
        return { ok: true };
      case "autopilot.resume":
        if (s.autopilot.enabled) return { ok: false, error: "already running" };
        server.patchState({ autopilot: { enabled: true, pausedReason: null } });
        logger.info("autopilot.toggled", `autopilot resumed (${from})`, { enabled: true, from });
        autopilot.onAutopilotChanged(true);
        return { ok: true };
      case "countdown.cancel":
        return autopilot.cancelCountdown();
      case "ratelimit.skip_wait":
        return autopilot.skipWait();
    }
  }

  try {
    await server.listen();
  } catch (e) {
    process.stderr.write(`csuper: ${(e as Error).message}\n`);
    return 70;
  }

  let pchild: IPty;
  try {
    pchild = pty.spawn(claudeBin, args, {
      name: process.env.TERM || "xterm-256color",
      cols: process.stdout.columns || 80,
      rows: process.stdout.rows || 24,
      cwd,
      env: claudeChildEnv(process.env, { id, sockPath }),
    });
  } catch (e) {
    autopilot.dispose();
    await server.close();
    process.stderr.write(`csuper: could not start claude: ${(e as Error).message}\n`);
    return 70;
  }
  child = pchild;

  server.patchState({ session: { claudePid: pchild.pid } });
  const info: SessionInfo = {
    id,
    pid: process.pid,
    claude_pid: pchild.pid,
    cwd,
    started_at: startedAt,
    config_path: configPath,
    version: opts.version,
    claude_session_id: opts.resumeId && !opts.fork ? opts.resumeId : null,
    adoptedFrom: opts.adoptedFrom ?? null,
  };
  writeSessionInfo(info);
  if (opts.adoptedFrom) {
    logger.info("adopt.resumed", `adopted claude conversation ${opts.adoptedFrom.claudeSessionId}`, {
      ...opts.adoptedFrom,
      autopilot: state.autopilot.enabled,
      compact: !!opts.compact,
    });
  }
  logger.info("session.start", opts.resumeId ? `resumed claude conversation ${opts.resumeId}` : "started claude", {
    cwd,
    claude_pid: pchild.pid,
    resume: opts.resumeId ?? null,
    fork: !!opts.fork,
    hooks: !!hookPath,
  });
  if (!hookPath) logger.warn("hook.error", "hook script not found; tool events won't be reported");
  say(
    `session ${id}${opts.resumeId ? ` · resuming ${opts.resumeId.slice(0, 8)}` : ""} · ` +
      (state.autopilot.enabled ? "Ctrl+G pauses autopilot" : "autopilot PAUSED (Ctrl+G starts it)") +
      " · `csuper dash` in another tab",
  );

  // Once claude registers itself (~/.claude/sessions/<pid>.json, undocumented), record
  // which conversation it has open, check nobody else has it open too, and send
  // /compact if asked. Without the registry, /compact falls back to a timer.
  let compactSent = !opts.compact;
  const sendCompact = (why: string) => {
    if (compactSent) return;
    compactSent = true;
    pchild.write("/compact");
    setTimeout(() => pchild.write("\r"), 150);
    logger.info("command.injected", `sent /compact (${why})`, { command: "/compact", why });
  };
  const watchStart = Date.now();
  let registered = false;
  const watch = setInterval(() => {
    const quiet = Date.now() - lastOutput > 1000;
    if (!registered) {
      const mine = readClaudeRegistry().find((e) => e.pid === pchild.pid);
      if (mine) {
        registered = true;
        const changed = mine.sessionId !== info.claude_session_id;
        info.claude_session_id = mine.sessionId;
        if (info.adoptedFrom && mine.sessionId !== info.adoptedFrom.claudeSessionId) info.adoptedFrom.resumedSessionId = mine.sessionId;
        if (changed) writeSessionInfo(info);
        const others = readClaudeRegistry().filter((e) => e.sessionId === mine.sessionId && e.pid !== pchild.pid);
        if (others.length) {
          server.patchState({ autopilot: { enabled: false, pausedReason: "blocked" } });
          logger.error("adopt.failed", `conversation ${mine.sessionId} is also open in pid ${others.map((o) => o.pid).join(", ")}; autopilot blocked`, {
            claudeSessionId: mine.sessionId,
            otherPids: others.map((o) => o.pid),
          });
        }
      }
    }
    if (!compactSent && quiet && (registered || Date.now() - watchStart > 15_000)) sendCompact(registered ? "claude ready" : "timeout");
    if (registered && compactSent) clearInterval(watch);
    else if (Date.now() - watchStart > 30_000) {
      clearInterval(watch);
      if (!registered) logger.debug("hook.error", `claude pid ${pchild.pid} never appeared in ${claudeRegistryFile(pchild.pid)}`);
    }
  }, 250);
  watch.unref();

  // Terminal passthrough.
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  const onInput = (buf: Buffer) => {
    // Only a lone Ctrl+G keypress; BEL also terminates OSC replies from the terminal.
    if (buf.length === 1 && buf[0] === CTRL_G) {
      control(server.getState().autopilot.enabled ? "autopilot.pause" : "autopilot.resume", "keyboard");
      return;
    }
    pchild.write(buf);
  };
  stdin.on("data", onInput);
  const onResize = () => {
    try {
      pchild.resize(process.stdout.columns || 80, process.stdout.rows || 24);
    } catch {
      /* child already gone */
    }
  };
  process.stdout.on("resize", onResize);
  pchild.onData((d) => {
    lastOutput = Date.now();
    autopilot.onPtyData(d);
    try {
      process.stdout.write(d);
    } catch {
      /* terminal gone */
    }
  });

  const forward = (sig: NodeJS.Signals) => () => {
    logger.info("claude.exited", `received ${sig}, stopping claude`);
    try {
      pchild.kill(sig);
    } catch {
      /* gone */
    }
    // If claude ignores it, don't hang around forever.
    setTimeout(() => pchild.kill("SIGKILL"), 5000).unref();
  };
  const handlers = (["SIGTERM", "SIGHUP"] as const).map((s) => [s, forward(s)] as const);
  for (const [s, h] of handlers) process.on(s, h);

  const { exitCode, signal } = await new Promise<{ exitCode: number; signal?: number }>((r) => pchild.onExit(r));

  clearInterval(watch);
  autopilot.dispose();
  stdin.off("data", onInput);
  process.stdout.off("resize", onResize);
  for (const [s, h] of handlers) process.off(s, h);
  try {
    stdin.setRawMode(false);
  } catch {
    /* ignore */
  }
  stdin.pause();
  const code = signal ? 128 + signal : exitCode;
  logger.info("claude.exited", `claude exited (${signal ? `signal ${signal}` : `code ${exitCode}`})`, { exit_code: exitCode, signal: signal || null });
  logger.info("session.end", `session ${id} ended`);
  await server.close();
  removeSession(id);
  say(`session ${id} ended (claude exited ${signal ? `on signal ${signal}` : exitCode})`);
  return code;
}
