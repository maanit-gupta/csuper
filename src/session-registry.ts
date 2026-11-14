import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { ensureHome, sessionsDir } from "./paths.js";

/** Contents of ~/.csuper/sessions/<id>.json (docs/dashboard-spec.md §6.1). */
export interface SessionInfo {
  id: string;
  pid: number;
  claude_pid: number;
  cwd: string;
  started_at: string;
  config_path: string | null;
  version: string;
  /** Claude Code conversation this claude has open, once known. */
  claude_session_id?: string | null;
  /** Set when the session was created by `csuper adopt` (or `csuper resume`). */
  adoptedFrom?: AdoptedFrom | null;
}

export interface AdoptedFrom {
  /** The conversation that was adopted. */
  claudeSessionId: string;
  adoptedAt: string;
  /** PID of the original claude that csuper ended first, if any. */
  stoppedPid: number | null;
  /** Set when resuming produced a different conversation ID (--fork). */
  resumedSessionId?: string | null;
}

export type SessionStatus = "live" | "stale";

export interface SessionEntry {
  id: string;
  info: SessionInfo | null; // null when only a .sock exists
  sockPath: string;
  jsonPath: string;
  status: SessionStatus;
  staleReason?: string;
}

const ID_RE = /^[0-9a-f]{6}$/;

/** Session ID format: 6-char random lowercase hex. */
export function newSessionId(dir = sessionsDir()): string {
  for (let i = 0; i < 100; i++) {
    const id = crypto.randomBytes(3).toString("hex");
    if (!fs.existsSync(path.join(dir, `${id}.json`)) && !fs.existsSync(path.join(dir, `${id}.sock`))) return id;
  }
  throw new Error("could not allocate a unique session id");
}

export function isValidSessionId(id: string): boolean {
  return ID_RE.test(id);
}

export function sockPathFor(id: string, dir = sessionsDir()): string {
  return path.join(dir, `${id}.sock`);
}

export function jsonPathFor(id: string, dir = sessionsDir()): string {
  return path.join(dir, `${id}.json`);
}

/** Written by the daemon at startup. */
export function writeSessionInfo(info: SessionInfo, dir = sessionsDir()): string {
  ensureHome(path.dirname(dir));
  const p = jsonPathFor(info.id, dir);
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(info, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, p);
  return p;
}

/** Called on clean teardown: removes both <id>.sock and <id>.json. */
export function removeSession(id: string, dir = sessionsDir()): void {
  for (const p of [sockPathFor(id, dir), jsonPathFor(id, dir)]) {
    try {
      fs.unlinkSync(p);
    } catch (e: any) {
      if (e?.code !== "ENOENT") throw e;
    }
  }
}

export function readSessionInfo(id: string, dir = sessionsDir()): SessionInfo | null {
  try {
    return JSON.parse(fs.readFileSync(jsonPathFor(id, dir), "utf8")) as SessionInfo;
  } catch {
    return null;
  }
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM"; // exists but owned by someone else
  }
}

/** Try to connect to a socket; resolves null on success or the error code on failure. */
export function probeSocket(sockPath: string, timeoutMs = 500): Promise<string | null> {
  return new Promise((resolve) => {
    const sock = net.createConnection(sockPath);
    const timer = setTimeout(() => {
      sock.destroy();
      resolve("ETIMEDOUT");
    }, timeoutMs);
    sock.once("connect", () => {
      clearTimeout(timer);
      sock.end();
      resolve(null);
    });
    sock.once("error", (e: any) => {
      clearTimeout(timer);
      resolve(e?.code ?? "ERROR");
    });
  });
}

/** List every session ID known on disk (from .json or .sock files). */
export function listSessionIds(dir = sessionsDir()): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const ids = new Set<string>();
  for (const n of names) {
    const m = /^([0-9a-f]{6})\.(json|sock)$/.exec(n);
    if (m) ids.add(m[1]);
  }
  return [...ids].sort();
}

/**
 * Enumerate sessions and classify each as live or stale. A session is stale when
 * connecting returns ECONNREFUSED/ENOENT (or times out) or its pid is not alive.
 */
export async function listSessions(dir = sessionsDir(), probeTimeoutMs = 500): Promise<SessionEntry[]> {
  const ids = listSessionIds(dir);
  return Promise.all(
    ids.map(async (id): Promise<SessionEntry> => {
      const info = readSessionInfo(id, dir);
      const sockPath = sockPathFor(id, dir);
      const entry: SessionEntry = { id, info, sockPath, jsonPath: jsonPathFor(id, dir), status: "live" };
      if (info && !isPidAlive(info.pid)) return { ...entry, status: "stale", staleReason: `pid ${info.pid} not alive` };
      const err = await probeSocket(sockPath, probeTimeoutMs);
      if (err) return { ...entry, status: "stale", staleReason: `socket ${err}` };
      if (!info) return { ...entry, status: "stale", staleReason: "missing session json" };
      return entry;
    }),
  );
}

/** Remove the files of every stale session. Returns the removed IDs. */
export async function pruneStale(dir = sessionsDir()): Promise<string[]> {
  const sessions = await listSessions(dir);
  const removed: string[] = [];
  for (const s of sessions) {
    if (s.status === "stale") {
      removeSession(s.id, dir);
      removed.push(s.id);
    }
  }
  return removed;
}

export type ResolveResult =
  | { kind: "ok"; session: SessionEntry }
  | { kind: "not_found"; id: string | null; sessions: SessionEntry[] }
  | { kind: "ambiguous"; sessions: SessionEntry[] };

/**
 * Pick a session for a one-shot command. Explicit id (flag or CSUPER_SESSION) wins;
 * stale sessions are returned as-is so callers can report them (exit 4).
 * Without an id: exactly one live session → it; none → not_found; several → ambiguous.
 */
export async function resolveSession(id: string | undefined | null, dir = sessionsDir()): Promise<ResolveResult> {
  const sessions = await listSessions(dir);
  const wanted = id || process.env.CSUPER_SESSION || null;
  if (wanted) {
    const s = sessions.find((x) => x.id === wanted);
    return s ? { kind: "ok", session: s } : { kind: "not_found", id: wanted, sessions };
  }
  const live = sessions.filter((s) => s.status === "live");
  if (live.length === 1) return { kind: "ok", session: live[0] };
  if (live.length === 0) return { kind: "not_found", id: null, sessions };
  return { kind: "ambiguous", sessions: live };
}
