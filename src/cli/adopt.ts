/**
 * `csuper adopt`: continue ordinary Claude Code conversations as csuper sessions.
 * `csuper resume` is the same code path (`adopt <id> --here`, scoped to this folder).
 *
 * csuper can't take over a running claude's terminal, so adopting means:
 *   find the conversation → make sure no claude has it open (refuse, or end the
 *   original with --stop-original after y/N) → run `claude --resume <id>` under
 *   csuper's PTY in the conversation's own folder.
 *
 * Transcripts under ~/.claude are only ever read. Nothing is stopped without a y/N,
 * nothing gets SIGKILL, and a conversation is never opened by two claudes at once:
 * liveness is checked when planning and again right before each launch.
 *
 * This runs before any PTY exists, so printing to stdout/stderr is fine here.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { parseArgs } from "node:util";
import { defaultConfig, loadConfig, type AdoptConfig } from "../config.js";
import { Logger } from "../logger.js";
import { ensureHome, logsDir, sessionsDir } from "../paths.js";
import { listSessionIds, readSessionInfo, type AdoptedFrom } from "../session-registry.js";
import {
  claudeRegistryFile,
  classifySession,
  detectLiveClaudes,
  findClaudeSession,
  listAllClaudeSessions,
  listClaudeSessions,
  type AdoptStatus,
  type ClaudeSession,
  type LiveClaudes,
  type SupervisedClaude,
} from "../supervisor/claude-sessions.js";
import { checkSignalTarget, signalContext, stopOriginal, supervisedClaudes, type SignalContext } from "../supervisor/stop-original.js";
import { runSupervisor } from "../supervisor/supervisor.js";
import type { PickerRow } from "./AdoptPicker.js";
import { shortenHome, sinceIso } from "./format.js";

export const ADOPT_USAGE = `usage: csuper adopt [<conversation-id>…] [--latest | --all-live] [options] [-- <claude args>]

Continue existing Claude Code conversations as csuper sessions (claude --resume
under csuper, in the conversation's own folder). With no id, pick from a list.

  <conversation-id>   full UUID or a unique prefix (any project)
  --latest            the most recent conversation for this folder
  --all-live          every conversation that's open in claude right now
  --stop-original     end the original claude first (asks y/N; SIGTERM, never SIGKILL)
  --fork              continue in a new conversation ID; the original can stay open
  --compact           send /compact right after resuming
  --autopilot         start with autopilot on (default: paused; Ctrl+G or \`p\` in dash)
  --paused            start paused even if adopt.default_autopilot is true
  --here              open in this terminal (one conversation only)
  --tabs              open a new terminal tab per conversation (Terminal.app, iTerm2)
  --dry-run           show what would happen and change nothing`;

export const RESUME_USAGE = `usage: csuper resume [<conversation-id>] [--fork] [--list] [adopt options] [-- <claude args>]

Same as \`csuper adopt <id> --here\` for a conversation from this folder: claude is
restarted under csuper with the full history (claude --resume). Autopilot starts
paused unless you pass --autopilot.

  <conversation-id>  full UUID or a unique prefix; omit to pick from a list
  --fork             continue in a new conversation ID (works while the
                     original is still open elsewhere)
  --list             print this folder's conversations and exit`;

export type OpenMode = "here" | "tabs";

export interface AdoptFlags {
  ids: string[];
  latest?: boolean;
  allLive?: boolean;
  stopOriginal?: boolean;
  fork?: boolean;
  compact?: boolean;
  autopilot?: boolean;
  paused?: boolean;
  here?: boolean;
  tabs?: boolean;
  dryRun?: boolean;
  list?: boolean;
  /** Internal: set by the parent csuper when it opens a tab after stopping the original. */
  stoppedPid?: number | null;
  claudeArgs: string[];
  /** `csuper resume`: conversations from this folder only, always --here. */
  resumeMode?: boolean;
}

// ---------------------------------------------------------------- planning (pure)

export type PlanAction = "adopt" | "stop-then-adopt" | "refuse";

export interface PlanItem {
  session: ClaudeSession;
  status: AdoptStatus;
  /** Process holding the conversation open (to stop, or named in the refusal). */
  pid: number | null;
  action: PlanAction;
  reason: string | null;
}

/** Decide what to do with one conversation. Never decides to stop without --stop-original. */
export function planItem(
  session: ClaudeSession,
  c: { status: AdoptStatus; pid: number | null; csuperId: string | null; candidates: number[] },
  f: { stopOriginal?: boolean; fork?: boolean },
  ctx: SignalContext | null,
): PlanItem {
  const base = { session, status: c.status, pid: c.pid };
  const short = session.id.slice(0, 8);
  if (c.status === "already csuper")
    return { ...base, action: "refuse", reason: `already supervised by csuper session ${c.csuperId} (claude pid ${c.pid})` };
  if (c.status === "ended") return { ...base, action: "adopt", reason: null };
  // live / possibly live
  const where = c.status === "live" ? `is still open in claude (pid ${c.pid})` : `may still be open: claude pid${c.candidates.length > 1 ? "s" : ""} ${c.candidates.join(", ")} in that folder isn't in Claude Code's session registry`;
  if (f.fork) return { ...base, action: "adopt", reason: null };
  if (!f.stopOriginal)
    return {
      ...base,
      action: "refuse",
      reason: `${where}. Two claudes writing one conversation would corrupt it. Quit it there (/exit) and run csuper adopt ${short} again, add --stop-original to end it from here, or --fork to continue a copy`,
    };
  if (c.pid === null) return { ...base, action: "refuse", reason: `${where}; can't tell which one to stop. Quit the right one (/exit) first` };
  if (ctx) {
    const gate = checkSignalTarget(c.pid, ctx);
    if (!gate.ok) return { ...base, action: "refuse", reason: `won't stop it: ${gate.reason}` };
  }
  return { ...base, action: "stop-then-adopt", reason: c.status === "possibly live" ? "possibly this conversation (same folder, not in the registry)" : null };
}

/** Where sessions open: --here only for one; otherwise the flag, then config, then tabs. */
export function openModeFor(n: number, f: { here?: boolean; tabs?: boolean; resumeMode?: boolean }, cfg: AdoptConfig): { mode: OpenMode; explicit: boolean } | { error: string } {
  if (f.here && f.tabs) return { error: "--here and --tabs can't be combined" };
  if (f.resumeMode) return { mode: "here", explicit: true };
  if (f.here) return n > 1 ? { error: `--here opens one session; ${n} were selected (use --tabs)` } : { mode: "here", explicit: true };
  if (f.tabs) return { mode: "tabs", explicit: true };
  if (n > 1) return { mode: "tabs", explicit: false };
  return { mode: cfg.default_open_mode, explicit: false };
}

// ---------------------------------------------------------------- tabs

export const shq = (s: string) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
const asq = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export type TabLauncher = { name: string; open: (command: string) => { ok: true; note?: string } | { ok: false; error: string } };

function osa(lines: string[]): { ok: boolean; err: string } {
  const r = spawnSync("osascript", lines.flatMap((l) => ["-e", l]), { encoding: "utf8", timeout: 15_000 });
  return { ok: r.status === 0, err: (r.stderr || r.error?.message || "").trim() };
}

/** Pick how to open tabs: CSUPER_TAB_LAUNCHER (tests/other terminals), iTerm2, Terminal.app. */
export function tabLauncher(env: NodeJS.ProcessEnv = process.env): TabLauncher | { error: string } {
  if (env.CSUPER_TAB_LAUNCHER) {
    const exe = env.CSUPER_TAB_LAUNCHER;
    return {
      name: path.basename(exe),
      open: (command) => {
        try {
          spawn(exe, [command], { detached: true, stdio: "ignore", env }).unref();
          return { ok: true };
        } catch (e) {
          return { ok: false, error: (e as Error).message };
        }
      },
    };
  }
  if (env.TERM_PROGRAM === "iTerm.app")
    return {
      name: "iTerm2",
      open: (command) => {
        const r = osa([
          'tell application "iTerm2"',
          "  tell current window",
          "    set t to (create tab with default profile)",
          `    tell current session of t to write text ${asq(command)}`,
          "  end tell",
          "end tell",
        ]);
        return r.ok ? { ok: true } : { ok: false, error: `osascript: ${r.err}` };
      },
    };
  if (env.TERM_PROGRAM === "Apple_Terminal")
    return {
      name: "Terminal",
      open: (command) => {
        // New tab = ⌘T through System Events, which needs Accessibility permission.
        const tab = osa([
          'tell application "Terminal" to activate',
          'tell application "System Events" to keystroke "t" using command down',
          "delay 0.4",
          `tell application "Terminal" to do script ${asq(command)} in selected tab of front window`,
        ]);
        if (tab.ok) return { ok: true };
        const win = osa([`tell application "Terminal" to do script ${asq(command)}`]);
        return win.ok
          ? { ok: true, note: "opened in a new window (allow your terminal under System Settings → Privacy & Security → Accessibility for tabs)" }
          : { ok: false, error: `osascript: ${win.err || tab.err}` };
      },
    };
  return {
    error: `can't open tabs in ${env.TERM_PROGRAM ? `"${env.TERM_PROGRAM}"` : "this terminal"} (supported: Terminal.app, iTerm2). Use --here to adopt one conversation in this terminal.`,
  };
}

/** Env a fresh tab won't inherit from this shell but the child csuper needs. */
const CARRY_ENV = ["CSUPER_HOME", "CSUPER_CONFIG", "CSUPER_CLAUDE_BIN", "CLAUDE_CONFIG_DIR", "NO_COLOR"];

/** Shell command a new tab runs: `cd <cwd> && env … csuper adopt <id> --here …`. */
export function tabCommand(o: { cwd: string; id: string; csuper: string[]; autopilot: boolean; compact: boolean; fork: boolean; stoppedPid: number | null; claudeArgs: string[]; env: NodeJS.ProcessEnv; configPath: string | null }): string {
  const envs = CARRY_ENV.filter((k) => o.env[k] !== undefined).map((k) => `${k}=${shq(o.env[k]!)}`);
  if (o.configPath && !o.env.CSUPER_CONFIG) envs.push(`CSUPER_CONFIG=${shq(o.configPath)}`);
  const args = [
    ...o.csuper,
    "adopt",
    o.id,
    "--here",
    o.autopilot ? "--autopilot" : "--paused",
    ...(o.compact ? ["--compact"] : []),
    ...(o.fork ? ["--fork"] : []),
    ...(o.stoppedPid ? ["--stopped-pid", String(o.stoppedPid)] : []),
    ...(o.claudeArgs.length ? ["--", ...o.claudeArgs] : []),
  ];
  return `cd ${shq(o.cwd)} && ${envs.length ? `env ${envs.join(" ")} ` : ""}${args.map(shq).join(" ")}`;
}

/** The csuper adopting `id` (by adoptedFrom), once its registry entry appears. */
function findAdopter(id: string, after: number, dir = sessionsDir()): string | null {
  for (const sid of listSessionIds(dir)) {
    const info = readSessionInfo(sid, dir);
    if (info?.adoptedFrom?.claudeSessionId === id && Date.parse(info.started_at) >= after - 1000) return sid;
  }
  return null;
}

// ---------------------------------------------------------------- output

export interface SummaryRow {
  session: string;
  project: string;
  result: string;
  csuper: string;
}

export function summaryTable(rows: SummaryRow[]): string {
  const head: SummaryRow = { session: "SESSION", project: "PROJECT", result: "RESULT", csuper: "CSUPER" };
  const all = [head, ...rows];
  const w = (k: keyof SummaryRow, max: number) => Math.min(max, Math.max(...all.map((r) => r[k].length)));
  const ws = w("session", 8), wp = w("project", 40), wc = w("csuper", 6);
  const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));
  return all.map((r) => `${cut(r.session, ws)}  ${cut(r.project, wp)}  ${cut(r.csuper, wc)}  ${r.result}`).join("\n");
}

function listLine(s: ClaudeSession, livePid: number | null, now: number): string {
  const live = livePid ? ` [open, pid ${livePid}]` : "";
  const text = (s.title ?? s.firstPrompt).slice(0, 70);
  return `${s.id}  ${sinceIso(s.updatedAt, now).padStart(12)}${live}  ${text}`;
}

async function askYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((r) => rl.question(question, r));
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------- main

function quietAdoptConfig(): { cfg: AdoptConfig; path: string | null } {
  try {
    const { config, path: p } = loadConfig();
    return { cfg: config.adopt, path: p };
  } catch (e) {
    process.stderr.write(`csuper: invalid config, using defaults (${(e as Error).message.split("\n")[0]})\n`);
    return { cfg: defaultConfig().adopt, path: null };
  }
}

export function parseAdoptArgv(argv: string[], resumeMode: boolean): AdoptFlags | { help: true } | { error: string } {
  const dd = argv.indexOf("--");
  const own = dd >= 0 ? argv.slice(0, dd) : argv;
  const claudeArgs = dd >= 0 ? argv.slice(dd + 1) : [];
  try {
    const { values: v, positionals } = parseArgs({
      args: own,
      allowPositionals: true,
      options: {
        latest: { type: "boolean" },
        "all-live": { type: "boolean" },
        "stop-original": { type: "boolean" },
        fork: { type: "boolean" },
        compact: { type: "boolean" },
        autopilot: { type: "boolean" },
        paused: { type: "boolean" },
        here: { type: "boolean" },
        tabs: { type: "boolean" },
        "dry-run": { type: "boolean" },
        list: { type: "boolean" },
        "stopped-pid": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
    if (v.help) return { help: true };
    if (resumeMode && positionals.length > 1) return { error: "expected at most one conversation id" };
    if (resumeMode && (v.tabs || v["all-live"])) return { error: "resume opens one conversation here; use csuper adopt for --tabs/--all-live" };
    if (v.autopilot && v.paused) return { error: "--autopilot and --paused can't be combined" };
    if ([positionals.length > 0, !!v.latest, !!v["all-live"]].filter(Boolean).length > 1) return { error: "pass ids, --latest or --all-live, not several" };
    const stopped = v["stopped-pid"] === undefined ? null : Number(v["stopped-pid"]);
    if (stopped !== null && !Number.isInteger(stopped)) return { error: "--stopped-pid must be a pid" };
    return {
      ids: positionals,
      latest: v.latest,
      allLive: v["all-live"],
      stopOriginal: v["stop-original"],
      fork: v.fork,
      compact: v.compact,
      autopilot: v.autopilot,
      paused: v.paused,
      here: v.here,
      tabs: v.tabs,
      dryRun: v["dry-run"],
      list: v.list,
      stoppedPid: stopped,
      claudeArgs,
      resumeMode,
    };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export async function runAdoptCli(argv: string[], version: string, resumeMode = false): Promise<number> {
  const cmd = resumeMode ? "resume" : "adopt";
  const usage = resumeMode ? RESUME_USAGE : ADOPT_USAGE;
  const f = parseAdoptArgv(argv, resumeMode);
  if ("help" in f) {
    process.stdout.write(usage + "\n");
    return 0;
  }
  if ("error" in f) {
    process.stderr.write(`csuper ${cmd}: ${f.error}\n\n${usage}\n`);
    return 64;
  }
  return runAdopt(f, version);
}

export async function runAdopt(f: AdoptFlags, version: string): Promise<number> {
  const cmd = f.resumeMode ? "resume" : "adopt";
  const err = (s: string) => process.stderr.write(`csuper ${cmd}: ${s}\n`);
  const out = (s: string) => process.stdout.write(s + "\n");
  const { cfg, path: configPath } = quietAdoptConfig();
  ensureHome();
  const log = new Logger({ session: "adopt", file: path.join(logsDir(), "adopt.jsonl"), maxBytes: 1_048_576, keepFiles: 2 });
  const cwd = process.cwd();
  const now = Date.now();

  // ---- scan
  let live: LiveClaudes = detectLiveClaudes();
  let supervised: SupervisedClaude[] = supervisedClaudes();
  const classify = (s: ClaudeSession) => classifySession(s, live, supervised);
  let pool: ClaudeSession[];
  if (f.resumeMode || f.latest) pool = listClaudeSessions(cwd);
  else if (f.ids.length) pool = f.ids.flatMap((id) => listAllClaudeSessions({ id }));
  else if (f.allLive) pool = listAllClaudeSessions({ only: new Set(live.bySession.keys()) });
  else pool = listAllClaudeSessions({ limit: cfg.scan_limit });
  log.info("adopt.scan", `found ${pool.length} conversation(s)`, {
    mode: f.resumeMode ? "resume" : f.latest ? "latest" : f.ids.length ? "ids" : f.allLive ? "all-live" : "picker",
    live: live.bySession.size,
    unmatched: live.unmatched.map((p) => p.pid),
  });

  if (pool.length === 0) {
    if (f.resumeMode || f.latest) err(`no Claude Code conversations found for ${shortenHome(cwd)}\n(run it from the folder where you started claude)`);
    else if (f.allLive) err("no conversations are open in claude right now");
    else if (f.ids.length) err(`no conversation matching ${f.ids.join(", ")}`);
    else err("no Claude Code conversations found");
    return f.allLive ? 0 : 2;
  }
  if (f.list) {
    out(pool.map((s) => listLine(s, live.bySession.get(s.id) ?? null, now)).join("\n"));
    return 0;
  }

  // ---- select
  let chosen: ClaudeSession[];
  if (f.ids.length) {
    chosen = [];
    for (const id of f.ids) {
      const hit = findClaudeSession(pool, id);
      if (hit === "ambiguous") {
        err(`"${id}" matches several conversations; use more characters`);
        return 2;
      }
      if (!hit) {
        err(f.resumeMode ? `no conversation "${id}" in ${shortenHome(cwd)}\nList them with: csuper resume --list` : `no conversation "${id}"`);
        return 2;
      }
      if (!chosen.includes(hit)) chosen.push(hit);
    }
  } else if (f.latest) chosen = [pool[0]];
  else if (f.allLive) chosen = pool.filter((s) => classify(s).status === "live" || classify(s).status === "already csuper");
  else {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      err(`pass a conversation id when not on a terminal:\n${pool.map((s) => "  " + listLine(s, live.bySession.get(s.id) ?? null, now)).join("\n")}`);
      return 64;
    }
    const rows: PickerRow[] = pool.map((s) => ({ session: s, ...classify(s) }));
    const { pickSessions } = await import("./dash.js");
    const ids = await pickSessions(rows, {
      multi: !f.resumeMode,
      title: f.resumeMode ? "Resume a Claude Code conversation under csuper" : "Adopt Claude Code sessions into csuper",
      subtitle: f.resumeMode
        ? `${shortenHome(cwd)} · ${pool.length} conversation${pool.length === 1 ? "" : "s"}, newest first`
        : `${pool.length} most recent conversation${pool.length === 1 ? "" : "s"} across all projects, newest first`,
    });
    if (!ids) {
      err("cancelled");
      return 130;
    }
    chosen = ids.map((id) => pool.find((s) => s.id === id)!);
  }
  log.info("adopt.selected", `${chosen.length} conversation(s) selected`, { ids: chosen.map((s) => s.id) });

  const om = openModeFor(chosen.length, f, cfg);
  if ("error" in om) {
    err(om.error);
    return 64;
  }
  let mode = om.mode;
  let launcher: TabLauncher | null = null;
  if (mode === "tabs") {
    const l = tabLauncher();
    if ("error" in l) {
      if (!om.explicit && chosen.length === 1) mode = "here"; // config default; nothing to open tabs in
      else {
        err(l.error);
        return 64;
      }
    } else launcher = l;
  }

  // ---- plan
  const ctx = signalContext();
  const plan = chosen.map((s) => planItem(s, classify(s), f, ctx));
  const results = new Map<string, SummaryRow>();
  const row = (p: PlanItem, result: string, csuper = "—") =>
    results.set(p.session.id, { session: p.session.id.slice(0, 8), project: shortenHome(p.session.cwd), result, csuper });
  for (const p of plan) {
    if (p.action === "refuse") {
      row(p, `refused (${p.status}): ${p.reason}`);
      log.warn("adopt.failed", `refused ${p.session.id}: ${p.reason}`, { claudeSessionId: p.session.id, status: p.status, pid: p.pid });
    }
  }
  const todo = plan.filter((p) => p.action !== "refuse");

  if (f.dryRun) {
    out(`dry run: nothing will be changed. Open mode: ${mode}${launcher ? ` (${launcher.name})` : ""}; autopilot ${(f.autopilot ?? (!f.paused && cfg.default_autopilot)) ? "on" : "paused"}.`);
    for (const p of todo)
      row(p, p.action === "stop-then-adopt" ? `would stop pid ${p.pid} (SIGTERM), then adopt${p.reason ? ` — ${p.reason}` : ""}` : "would adopt");
    out(summaryTable(plan.map((p) => results.get(p.session.id)!)));
    return 0;
  }

  // ---- confirm and stop originals
  const toStop = todo.filter((p) => p.action === "stop-then-adopt");
  const stopped = new Map<string, number>();
  if (toStop.length) {
    out(`These claude processes will be ended (SIGTERM) so their conversations can be resumed under csuper:`);
    for (const p of toStop) out(`  pid ${String(p.pid).padEnd(7)} ${shortenHome(p.session.cwd)}  ${p.session.id.slice(0, 8)}${p.reason ? `  (${p.reason})` : ""}`);
    const yes = process.stdin.isTTY ? await askYesNo(`Stop ${toStop.length === 1 ? "it" : `all ${toStop.length}`}? [y/N] `) : false;
    if (!process.stdin.isTTY) err("--stop-original needs a y/N answer on a terminal; nothing was stopped");
    for (const p of toStop) {
      if (!yes) {
        row(p, `skipped: not confirmed (original pid ${p.pid} still running)`);
        continue;
      }
      log.info("adopt.stop_original", `stopping pid ${p.pid} for ${p.session.id}`, { claudeSessionId: p.session.id, pid: p.pid });
      const r = await stopOriginal({
        pid: p.pid!,
        transcript: p.session.file,
        registryFile: p.status === "live" ? claudeRegistryFile(p.pid!) : null,
        timeoutMs: cfg.stop_wait_timeout_ms,
        ctx: signalContext(),
      });
      if (r.ok) {
        stopped.set(p.session.id, p.pid!);
        log.info("adopt.stop_original", `pid ${p.pid} exited after ${r.waitedMs} ms`, { claudeSessionId: p.session.id, pid: p.pid, waitedMs: r.waitedMs });
      } else {
        row(p, `failed: ${r.reason}`);
        log.error("adopt.failed", `could not stop pid ${p.pid}: ${r.reason}`, { claudeSessionId: p.session.id, pid: p.pid });
      }
    }
  }
  const ready = todo.filter((p) => !results.has(p.session.id));

  // ---- launch
  const autopilot = f.autopilot ?? (!f.paused && cfg.default_autopilot);
  const compact = f.compact ?? cfg.compact_on_adopt;
  /** Last look before launching: nobody may have reopened it meanwhile. */
  const recheck = (p: PlanItem): string | null => {
    live = detectLiveClaudes();
    supervised = supervisedClaudes();
    const c = classify(p.session);
    if (c.status === "ended" || f.fork) return null;
    return planItem(p.session, c, { fork: f.fork }, null).reason;
  };

  if (mode === "here") {
    if (ready.length === 0) {
      out(summaryTable(plan.map((p) => results.get(p.session.id)!)));
      return 1;
    }
    const p = ready[0];
    const blocked = recheck(p);
    if (blocked) {
      log.warn("adopt.failed", `refused ${p.session.id} at launch: ${blocked}`, { claudeSessionId: p.session.id });
      err(`conversation ${p.session.id.slice(0, 8)} ${blocked}`);
      return 1;
    }
    if (!fs.existsSync(p.session.cwd)) {
      err(`the conversation's folder ${p.session.cwd} no longer exists`);
      log.error("adopt.failed", `cwd missing for ${p.session.id}`, { claudeSessionId: p.session.id, cwd: p.session.cwd });
      return 1;
    }
    const adoptedFrom: AdoptedFrom = {
      claudeSessionId: p.session.id,
      adoptedAt: new Date().toISOString(),
      stoppedPid: stopped.get(p.session.id) ?? f.stoppedPid ?? null,
    };
    return runSupervisor({ claudeArgs: f.claudeArgs, resumeId: p.session.id, fork: f.fork, version, cwd: p.session.cwd, autopilot, compact, adoptedFrom });
  }

  // tabs: each tab runs `csuper adopt <id> --here`, which re-checks liveness itself.
  const csuperCmd = [process.execPath, ...process.execArgv, fs.realpathSync(process.argv[1])];
  const started: Array<{ p: PlanItem; at: number }> = [];
  for (const p of ready) {
    const blocked = recheck(p);
    if (blocked) {
      row(p, `refused (now open again): ${blocked}`);
      log.warn("adopt.failed", `refused ${p.session.id} at launch: ${blocked}`, { claudeSessionId: p.session.id });
      continue;
    }
    if (!fs.existsSync(p.session.cwd)) {
      row(p, `failed: folder ${p.session.cwd} no longer exists`);
      log.error("adopt.failed", `cwd missing for ${p.session.id}`, { claudeSessionId: p.session.id, cwd: p.session.cwd });
      continue;
    }
    const command = tabCommand({
      cwd: p.session.cwd,
      id: p.session.id,
      csuper: csuperCmd,
      autopilot,
      compact,
      fork: !!f.fork,
      stoppedPid: stopped.get(p.session.id) ?? null,
      claudeArgs: f.claudeArgs,
      env: process.env,
      configPath,
    });
    const at = Date.now();
    const r = launcher!.open(command);
    if (!r.ok) {
      row(p, `failed: couldn't open a tab: ${r.error}`);
      log.error("adopt.failed", `tab for ${p.session.id} failed: ${r.error}`, { claudeSessionId: p.session.id });
      continue;
    }
    if (r.note) err(r.note);
    started.push({ p, at });
  }
  // Wait for each tab's csuper to register itself.
  const deadline = Date.now() + 15_000;
  const pending = new Set(started);
  while (pending.size && Date.now() < deadline) {
    for (const s of [...pending]) {
      const sid = findAdopter(s.p.session.id, s.at);
      if (sid) {
        row(s.p, `adopted in a new ${launcher!.name} tab`, sid);
        pending.delete(s);
      }
    }
    if (pending.size) await new Promise((r) => setTimeout(r, 200));
  }
  for (const s of pending) {
    row(s.p, "failed: tab opened but no csuper session appeared within 15 s (see that tab)");
    log.error("adopt.failed", `no csuper session appeared for ${s.p.session.id}`, { claudeSessionId: s.p.session.id });
  }
  out(summaryTable(plan.map((p) => results.get(p.session.id)!)));
  return plan.every((p) => results.get(p.session.id)!.result.startsWith("adopted")) ? 0 : 1;
}
