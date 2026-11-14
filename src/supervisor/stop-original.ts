/**
 * Ending an original `claude` before csuper resumes its conversation.
 *
 * Two hard rules:
 *   1. Never signal ourselves, an ancestor (e.g. the claude this was typed into), or
 *      a claude that csuper already supervises. `checkSignalTarget` is the gate and
 *      `stopOriginal` calls it itself, right before the signal.
 *   2. SIGTERM only, never SIGKILL. If claude doesn't finish within the timeout we
 *      report it and stop; the user decides what to do next.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { listSessionIds, readSessionInfo } from "../session-registry.js";
import { sessionsDir } from "../paths.js";
import { parsePs, pidAlive, type SupervisedClaude } from "./claude-sessions.js";

/** pid → ppid for every process, from `ps`. Empty on failure. */
export function processTree(): Map<number, number> {
  try {
    const text = execFileSync("ps", ["-A", "-o", "pid=,ppid=,args="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
    return new Map(parsePs(text).map((p) => [p.pid, p.ppid]));
  } catch {
    return new Map();
  }
}

/** `pid` and all of its ancestors, walking ppid links up to init. */
export function ancestorsOf(pid: number, tree: Map<number, number>): Set<number> {
  const out = new Set<number>();
  let cur: number | undefined = pid;
  while (cur !== undefined && cur > 1 && !out.has(cur)) {
    out.add(cur);
    cur = tree.get(cur);
  }
  return out;
}

/** Claudes run by live csuper sessions, from claude_pid in ~/.csuper/sessions/*.json. */
export function supervisedClaudes(dir = sessionsDir()): SupervisedClaude[] {
  const out: SupervisedClaude[] = [];
  for (const id of listSessionIds(dir)) {
    const info = readSessionInfo(id, dir);
    if (!info || !pidAlive(info.pid) || !pidAlive(info.claude_pid)) continue;
    out.push({ csuperId: id, claudePid: info.claude_pid, claudeSessionId: info.claude_session_id ?? info.adoptedFrom?.claudeSessionId ?? null });
  }
  return out;
}

export interface SignalContext {
  /** Our own pid plus every ancestor (process.ppid chain). */
  protectedPids: Set<number>;
  /** claude_pid of every csuper-supervised claude. */
  supervisedPids: Set<number>;
}

export function signalContext(opts: { tree?: Map<number, number>; csuperSessionsDir?: string } = {}): SignalContext {
  const tree = opts.tree ?? processTree();
  const protectedPids = ancestorsOf(process.pid, tree);
  protectedPids.add(process.pid);
  // ps can miss our parent if it raced; process.ppid is authoritative for the first hop.
  for (const p of ancestorsOf(process.ppid, tree)) protectedPids.add(p);
  protectedPids.add(process.ppid);
  return { protectedPids, supervisedPids: new Set(supervisedClaudes(opts.csuperSessionsDir).map((c) => c.claudePid)) };
}

/** May csuper send a signal to `pid`? */
export function checkSignalTarget(pid: number, ctx: SignalContext): { ok: true } | { ok: false; reason: string } {
  if (!Number.isInteger(pid) || pid <= 1) return { ok: false, reason: `invalid pid ${pid}` };
  if (pid === process.pid) return { ok: false, reason: "that is csuper itself" };
  if (ctx.protectedPids.has(pid)) return { ok: false, reason: `pid ${pid} is an ancestor of this csuper (e.g. the claude you ran it from)` };
  if (ctx.supervisedPids.has(pid)) return { ok: false, reason: `pid ${pid} is already supervised by csuper` };
  return { ok: true };
}

export interface StopOptions {
  pid: number;
  /** The conversation's transcript; must stop changing before we resume. */
  transcript: string;
  /** ~/.claude/sessions/<pid>.json, or null when the registry isn't available. */
  registryFile: string | null;
  timeoutMs: number;
  ctx: SignalContext;
  /** How long the transcript must stay unchanged. */
  quietMs?: number;
  kill?: (pid: number, sig: NodeJS.Signals) => void;
  alive?: (pid: number) => boolean;
}

export type StopResult = { ok: true; waitedMs: number } | { ok: false; reason: string };

function fileSig(f: string): string {
  try {
    const st = fs.statSync(f);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return "missing";
  }
}

/**
 * SIGTERM → wait until the process is gone, its registry entry is gone, and the
 * transcript has been unchanged for `quietMs` (1 s). Times out with an error, and
 * never escalates to SIGKILL.
 */
export async function stopOriginal(o: StopOptions): Promise<StopResult> {
  const gate = checkSignalTarget(o.pid, o.ctx);
  if (!gate.ok) return gate;
  const kill = o.kill ?? ((pid, sig) => process.kill(pid, sig));
  const alive = o.alive ?? pidAlive;
  const quietMs = o.quietMs ?? 1000;
  const t0 = Date.now();
  try {
    kill(o.pid, "SIGTERM");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") return { ok: false, reason: `could not signal pid ${o.pid}: ${code ?? (e as Error).message}` };
  }
  let sig = fileSig(o.transcript);
  let sigSince = Date.now();
  while (Date.now() - t0 < o.timeoutMs) {
    await new Promise((r) => setTimeout(r, 100));
    const now = fileSig(o.transcript);
    if (now !== sig) {
      sig = now;
      sigSince = Date.now();
    }
    const gone = !alive(o.pid);
    const unregistered = o.registryFile === null || !fs.existsSync(o.registryFile);
    if (gone && unregistered && Date.now() - sigSince >= quietMs) return { ok: true, waitedMs: Date.now() - t0 };
  }
  const what = alive(o.pid)
    ? `pid ${o.pid} is still running`
    : o.registryFile && fs.existsSync(o.registryFile)
      ? `its entry ${o.registryFile} is still there`
      : "its transcript is still changing";
  return { ok: false, reason: `timed out after ${o.timeoutMs} ms: ${what}. Not sending SIGKILL; end it yourself (/exit) and retry.` };
}
