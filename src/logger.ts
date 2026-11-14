import fs from "node:fs";
import path from "node:path";
import { ensurePrivateDir, logsDir } from "./paths.js";

export const LEVELS = ["debug", "info", "warn", "error"] as const;
export type Level = (typeof LEVELS)[number];

/** The fixed list of dotted event names (docs/dashboard-spec.md §7). */
export const EVENTS = [
  "session.start",
  "session.end",
  "trigger.matched",
  "command.injected",
  "countdown.started",
  "countdown.cancelled",
  "countdown.fired",
  "anomaly.detected",
  "git.checkpoint",
  "git.stash",
  "ratelimit.detected",
  "ratelimit.resume_scheduled",
  "ratelimit.resumed",
  "model.failover",
  "breaker.tripped",
  "autopilot.toggled",
  "control.received",
  "ipc.client_dropped",
  "hook.error",
  "tool.failed",
  "claude.exited",
  "config.reloaded",
  "dash.error",
  "adopt.scan",
  "adopt.selected",
  "adopt.stop_original",
  "adopt.resumed",
  "adopt.failed",
  "cycle.started",
  "cycle.step",
  "cycle.completed",
  "cycle.failed",
  "cycle.cancelled",
  "cycle.skipped",
  "cycle.phase",
  "handover.saved",
  "ratelimit.unparsed",
  "ratelimit.ignored",
  "ratelimit.resume_sent",
  "ratelimit.resume_turn",
  "ratelimit.resume_failed",
  "caffeinate.started",
  "caffeinate.stopped",
  "model.changed",
  "notify.sent",
] as const;
export type EventName = (typeof EVENTS)[number];

export interface LogRecord {
  ts: string;
  level: Level;
  session: string;
  event: string;
  msg: string;
  data?: Record<string, unknown>;
}

/** ISO-8601 timestamp with the local UTC offset, e.g. 2026-11-14T07:12:03.481+05:30. */
export function localIsoString(d = new Date()): string {
  const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`
  );
}

export interface LoggerOptions {
  session: string;
  /** Full path of the active log file, e.g. ~/.csuper/logs/<id>.jsonl */
  file?: string;
  maxBytes?: number;
  keepFiles?: number;
  minLevel?: Level;
}

/**
 * Append-only JSONL logger with size-based rotation. Never writes to stdout/stderr:
 * if the log file itself cannot be written, the record is dropped silently.
 */
export class Logger {
  readonly session: string;
  readonly file: string;
  private maxBytes: number;
  private keepFiles: number;
  private minLevel: Level;
  private size = 0;
  private listeners = new Set<(r: LogRecord) => void>();

  constructor(opts: LoggerOptions) {
    this.session = opts.session;
    this.file = opts.file ?? path.join(logsDir(), `${opts.session}.jsonl`);
    this.maxBytes = opts.maxBytes ?? 10_485_760;
    this.keepFiles = opts.keepFiles ?? 5;
    this.minLevel = opts.minLevel ?? "debug";
    try {
      ensurePrivateDir(path.dirname(this.file));
      this.size = fs.statSync(this.file).size;
    } catch {
      this.size = 0;
    }
  }

  setLimits(maxBytes: number, keepFiles: number): void {
    this.maxBytes = maxBytes;
    this.keepFiles = keepFiles;
  }

  /** Subscribe to every written record (used by the IPC server to fan logs out). */
  onRecord(fn: (r: LogRecord) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  log(level: Level, event: string, msg: string, data?: Record<string, unknown>): LogRecord | null {
    if (LEVELS.indexOf(level) < LEVELS.indexOf(this.minLevel)) return null;
    const rec: LogRecord = { ts: localIsoString(), level, session: this.session, event, msg };
    if (data !== undefined) rec.data = data;
    const line = JSON.stringify(rec) + "\n";
    try {
      const bytes = Buffer.byteLength(line);
      if (this.size > 0 && this.size + bytes > this.maxBytes) this.rotate();
      fs.appendFileSync(this.file, line, { mode: 0o600 });
      this.size += bytes;
    } catch {
      // Logging must never disturb the supervised session.
    }
    for (const fn of this.listeners) {
      try {
        fn(rec);
      } catch {
        /* ignore listener failures */
      }
    }
    return rec;
  }

  debug(event: string, msg: string, data?: Record<string, unknown>) {
    return this.log("debug", event, msg, data);
  }
  info(event: string, msg: string, data?: Record<string, unknown>) {
    return this.log("info", event, msg, data);
  }
  warn(event: string, msg: string, data?: Record<string, unknown>) {
    return this.log("warn", event, msg, data);
  }
  error(event: string, msg: string, data?: Record<string, unknown>) {
    return this.log("error", event, msg, data);
  }

  /** <id>.jsonl → <id>.1.jsonl → … → <id>.<keep>.jsonl (oldest dropped). */
  rotate(): void {
    const base = this.file.replace(/\.jsonl$/, "");
    const nth = (n: number) => `${base}.${n}.jsonl`;
    try {
      fs.rmSync(nth(this.keepFiles), { force: true });
      for (let n = this.keepFiles - 1; n >= 1; n--) {
        if (fs.existsSync(nth(n))) fs.renameSync(nth(n), nth(n + 1));
      }
      if (fs.existsSync(this.file)) fs.renameSync(this.file, nth(1));
    } catch {
      /* best effort */
    }
    this.size = 0;
  }
}

/** All files for a session's log, oldest first (rotated files, then the active one). */
export function sessionLogFiles(file: string): string[] {
  const base = file.replace(/\.jsonl$/, "");
  const dir = path.dirname(file);
  const stem = path.basename(base);
  let rotated: Array<{ n: number; p: string }> = [];
  try {
    rotated = fs
      .readdirSync(dir)
      .map((name) => {
        const m = new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.(\\d+)\\.jsonl$`).exec(name);
        return m ? { n: Number(m[1]), p: path.join(dir, name) } : null;
      })
      .filter((x): x is { n: number; p: string } => x !== null);
  } catch {
    return [];
  }
  rotated.sort((a, b) => b.n - a.n);
  const out = rotated.map((r) => r.p);
  if (fs.existsSync(file)) out.push(file);
  return out;
}

/** The dashboard's own diagnostics log (~/.csuper/logs/dash.jsonl). */
let dashLogger: Logger | null = null;
export function dashLog(): Logger {
  if (!dashLogger) dashLogger = new Logger({ session: "dash", file: path.join(logsDir(), "dash.jsonl"), maxBytes: 1_048_576, keepFiles: 2 });
  return dashLogger;
}
