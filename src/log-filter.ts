import { LEVELS, type Level, type LogRecord } from "./logger.js";

export type LevelFilter = "all" | Level;

export interface LogFilter {
  /** Minimum level; "all" accepts everything including debug. */
  level?: LevelFilter;
  /** Exact event name, or a prefix ending in "." / "*" (e.g. "ratelimit." or "ratelimit.*"). */
  event?: string;
  /** Case-insensitive substring searched in msg, event and JSON-encoded data. */
  text?: string;
  /** Only records at or after this time (ms since epoch). */
  sinceMs?: number;
}

/** Parse `--since`: "90s", "10m", "2h", "3d", or an ISO-8601 timestamp. Returns epoch ms. */
export function parseSince(value: string, now = Date.now()): number {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d|w)$/i.exec(value.trim());
  if (m) {
    const n = Number(m[1]);
    const unit = { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3, w: 604800e3 }[m[2].toLowerCase() as "s"]!;
    return now - n * unit;
  }
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new Error(`invalid --since value: ${value} (use e.g. 10m, 2h, 3d or an ISO timestamp)`);
  return t;
}

export function levelRank(l: string): number {
  const i = LEVELS.indexOf(l as Level);
  return i < 0 ? 1 : i; // unknown levels behave like info
}

/** Order used by the TUI `f` key: all → info+ → warn+ → error → all. */
export const LEVEL_CYCLE: LevelFilter[] = ["all", "info", "warn", "error"];
export function nextLevel(l: LevelFilter): LevelFilter {
  return LEVEL_CYCLE[(LEVEL_CYCLE.indexOf(l) + 1) % LEVEL_CYCLE.length];
}
export function levelLabel(l: LevelFilter): string {
  return l === "all" ? "all" : l === "error" ? "error" : `${l}+`;
}

export function matchesFilter(r: LogRecord, f: LogFilter): boolean {
  if (f.level && f.level !== "all" && levelRank(r.level) < levelRank(f.level)) return false;
  if (f.event) {
    const ev = f.event.endsWith("*") ? f.event.slice(0, -1) : f.event;
    if (ev.endsWith(".") ? !r.event.startsWith(ev) : r.event !== ev) return false;
  }
  if (f.sinceMs !== undefined) {
    const t = Date.parse(r.ts);
    if (Number.isNaN(t) || t < f.sinceMs) return false;
  }
  if (f.text) {
    const needle = f.text.toLowerCase();
    const hay = `${r.msg} ${r.event} ${r.data ? JSON.stringify(r.data) : ""}`.toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
}

/** Parse one JSONL line; returns null for blank or malformed lines. */
export function parseLogLine(line: string): LogRecord | null {
  const s = line.trim();
  if (!s) return null;
  try {
    const r = JSON.parse(s);
    if (!r || typeof r !== "object" || typeof r.ts !== "string" || typeof r.event !== "string") return null;
    return { level: "info", msg: "", session: "", ...r } as LogRecord;
  } catch {
    return null;
  }
}

export function filterLines(lines: string[], f: LogFilter): LogRecord[] {
  const out: LogRecord[] = [];
  for (const l of lines) {
    const r = parseLogLine(l);
    if (r && matchesFilter(r, f)) out.push(r);
  }
  return out;
}

const ANSI = { reset: "\x1b[0m", dim: "\x1b[2m", red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m", gray: "\x1b[90m" };
const LEVEL_COLOR: Record<string, string> = { debug: ANSI.gray, info: ANSI.cyan, warn: ANSI.yellow, error: ANSI.red };

export function formatTime(ts: string, fmt: "24h" | "12h" = "24h", withDate = false): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const pad = (n: number) => String(n).padStart(2, "0");
  let time: string;
  if (fmt === "12h") {
    const h = d.getHours() % 12 || 12;
    time = `${h}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${d.getHours() < 12 ? "AM" : "PM"}`;
  } else {
    time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  return withDate ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}` : time;
}

/** Human-readable one-line rendering used by `csuper logs` (pretty mode). */
export function formatRecord(r: LogRecord, opts: { color?: boolean; timeFormat?: "24h" | "12h" } = {}): string {
  const c = opts.color ?? false;
  const lvl = r.level.toUpperCase().padEnd(5);
  const data = r.data && Object.keys(r.data).length ? ` ${JSON.stringify(r.data)}` : "";
  const time = formatTime(r.ts, opts.timeFormat, true);
  if (!c) return `${time} ${lvl} ${r.event.padEnd(26)} ${r.msg}${data}`;
  const col = LEVEL_COLOR[r.level] ?? "";
  return `${ANSI.dim}${time}${ANSI.reset} ${col}${lvl}${ANSI.reset} ${r.event.padEnd(26)} ${r.msg}${ANSI.gray}${data}${ANSI.reset}`;
}
