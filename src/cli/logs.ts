import fs from "node:fs";
import path from "node:path";
import { formatRecord, matchesFilter, parseLogLine, parseSince, type LogFilter } from "../log-filter.js";
import { sessionLogFiles, type LogRecord } from "../logger.js";
import { logsDir } from "../paths.js";
import { isValidSessionId } from "../session-registry.js";
import { pickSession, stdio, type Io } from "./common.js";

export interface LogsOpts {
  session?: string;
  follow?: boolean;
  level?: string;
  event?: string;
  since?: string;
  n?: number;
  raw?: boolean;
  color?: boolean;
  timeFormat?: "24h" | "12h";
  sessionsDir?: string;
  logsDir?: string;
  /** Resolves when following should stop (tests); defaults to never. */
  signal?: AbortSignal;
}

/**
 * `csuper logs` reads the JSONL files directly, so it works for ended sessions too.
 * An explicit --session (or CSUPER_SESSION) is used as-is when its log file exists.
 */
export async function runLogs(opts: LogsOpts, io: Io = stdio): Promise<number> {
  const dir = opts.logsDir ?? logsDir();
  let id = opts.session || process.env.CSUPER_SESSION;
  if (!id || !fs.existsSync(path.join(dir, `${id}.jsonl`))) {
    const picked = await pickSession(id, io, opts.sessionsDir);
    if (typeof picked === "number") return picked;
    id = picked.id;
  }
  if (!isValidSessionId(id)) {
    io.err(`csuper: invalid session id: ${id}`);
    return 2;
  }
  if (opts.level && !["all", "debug", "info", "warn", "error"].includes(opts.level)) {
    io.err(`csuper logs: --level must be info, warn or error`);
    return 64;
  }
  let filter: LogFilter;
  try {
    filter = {
      level: (opts.level ?? "all") as LogFilter["level"],
      event: opts.event,
      sinceMs: opts.since ? parseSince(opts.since) : undefined,
    };
  } catch (e) {
    io.err(`csuper logs: ${(e as Error).message}`);
    return 64;
  }

  const file = path.join(dir, `${id}.jsonl`);
  // Keep the stored line next to each record so --raw prints it byte-for-byte.
  let matched: Array<{ r: LogRecord; raw: string }> = [];
  for (const f of sessionLogFiles(file)) {
    let text: string;
    try {
      text = fs.readFileSync(f, "utf8");
    } catch {
      continue; // rotated away mid-read
    }
    for (const raw of text.split("\n")) {
      const r = parseLogLine(raw);
      if (r && matchesFilter(r, filter)) matched.push({ r, raw: raw.trim() });
    }
  }
  const n = opts.n ?? 200;
  if (matched.length > n) matched = n <= 0 ? [] : matched.slice(-n); // -n 0 → only new lines (like tail)
  const print = (r: LogRecord, raw: string) =>
    io.out(opts.raw ? raw.trim() : formatRecord(r, { color: opts.color, timeFormat: opts.timeFormat }));
  for (const m of matched) print(m.r, m.raw);

  if (!opts.follow) return 0;
  await follow(file, (line) => {
    const r = parseLogLine(line);
    if (r && matchesFilter(r, filter)) print(r, line);
  }, opts.signal);
  return 0;
}

/** Tail a file with fs.watch, handling truncation/rotation (size shrinking or inode change). */
export function follow(file: string, onLine: (line: string) => void, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let offset = fs.existsSync(file) ? fs.statSync(file).size : 0;
    let ino = fs.existsSync(file) ? fs.statSync(file).ino : 0;
    let partial = "";
    let watcher: fs.FSWatcher | null = null;

    const read = () => {
      let st: fs.Stats;
      try {
        st = fs.statSync(file);
      } catch {
        return; // between rotate and recreate
      }
      if (st.ino !== ino || st.size < offset) {
        ino = st.ino;
        offset = 0;
        partial = "";
        rewatch();
      }
      if (st.size === offset) return;
      const fd = fs.openSync(file, "r");
      try {
        const buf = Buffer.alloc(st.size - offset);
        fs.readSync(fd, buf, 0, buf.length, offset);
        offset = st.size;
        const text = partial + buf.toString("utf8");
        const parts = text.split("\n");
        partial = parts.pop() ?? "";
        for (const p of parts) if (p.trim()) onLine(p);
      } finally {
        fs.closeSync(fd);
      }
    };

    const rewatch = () => {
      watcher?.close();
      try {
        watcher = fs.watch(file, read);
      } catch {
        watcher = null;
      }
    };
    // The directory watch catches the file being (re)created after rotation.
    const dirWatcher = fs.watch(path.dirname(file), (_e, name) => {
      if (name === path.basename(file)) read();
    });
    rewatch();
    // Safety net: fs.watch can coalesce events on macOS.
    const poll = setInterval(read, 1000);

    const stop = () => {
      clearInterval(poll);
      watcher?.close();
      dirWatcher.close();
      resolve();
    };
    signal?.addEventListener("abort", stop, { once: true });
  });
}
