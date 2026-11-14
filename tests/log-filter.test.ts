import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { filterLines, formatRecord, matchesFilter, nextLevel, parseLogLine, parseSince } from "../src/log-filter.js";
import { localIsoString, Logger, sessionLogFiles, type LogRecord } from "../src/logger.js";

const rec = (over: Partial<LogRecord>): LogRecord => ({
  ts: "2026-11-14T07:12:03.481+05:30",
  level: "info",
  session: "a1b2c3",
  event: "trigger.matched",
  msg: "::DONE:: matched (last_line)",
  data: { trigger: "task_complete", commands: ["/clear", "/next"] },
  ...over,
});

describe("log filtering", () => {
  it("filters by minimum level", () => {
    expect(matchesFilter(rec({ level: "debug" }), { level: "all" })).toBe(true);
    expect(matchesFilter(rec({ level: "debug" }), { level: "info" })).toBe(false);
    expect(matchesFilter(rec({ level: "info" }), { level: "warn" })).toBe(false);
    expect(matchesFilter(rec({ level: "error" }), { level: "warn" })).toBe(true);
    expect(matchesFilter(rec({ level: "warn" }), { level: "error" })).toBe(false);
  });

  it("filters by exact event and by prefix", () => {
    expect(matchesFilter(rec({}), { event: "trigger.matched" })).toBe(true);
    expect(matchesFilter(rec({}), { event: "trigger" })).toBe(false);
    expect(matchesFilter(rec({ event: "ratelimit.resumed" }), { event: "ratelimit." })).toBe(true);
    expect(matchesFilter(rec({ event: "ratelimit.resumed" }), { event: "ratelimit.*" })).toBe(true);
    expect(matchesFilter(rec({ event: "model.failover" }), { event: "ratelimit.*" })).toBe(false);
  });

  it("searches text case-insensitively across msg, event and data", () => {
    expect(matchesFilter(rec({}), { text: "done" })).toBe(true);
    expect(matchesFilter(rec({}), { text: "TASK_COMPLETE" })).toBe(true);
    expect(matchesFilter(rec({}), { text: "TRIGGER.MAT" })).toBe(true);
    expect(matchesFilter(rec({}), { text: "nope" })).toBe(false);
  });

  it("parses --since durations and ISO timestamps", () => {
    const now = Date.parse("2026-11-14T10:00:00Z");
    expect(parseSince("10m", now)).toBe(now - 600_000);
    expect(parseSince("2h", now)).toBe(now - 7_200_000);
    expect(parseSince("1d", now)).toBe(now - 86_400_000);
    expect(parseSince("2026-11-14T09:00:00Z", now)).toBe(Date.parse("2026-11-14T09:00:00Z"));
    expect(() => parseSince("yesterday", now)).toThrow(/invalid --since/);
  });

  it("filters by since, using absolute times across offsets", () => {
    const since = Date.parse("2026-11-14T01:42:00Z"); // == 07:12 +05:30
    expect(matchesFilter(rec({}), { sinceMs: since })).toBe(true);
    expect(matchesFilter(rec({}), { sinceMs: since + 10_000 })).toBe(false);
  });

  it("skips blank and malformed lines", () => {
    const lines = ["", "not json", JSON.stringify(rec({ level: "warn" })), "{\"no\":\"ts\"}", JSON.stringify(rec({}))];
    expect(parseLogLine("garbage")).toBeNull();
    expect(filterLines(lines, { level: "warn" })).toHaveLength(1);
    expect(filterLines(lines, {})).toHaveLength(2);
  });

  it("cycles levels all → info+ → warn+ → error → all", () => {
    expect([nextLevel("all"), nextLevel("info"), nextLevel("warn"), nextLevel("error")]).toEqual(["info", "warn", "error", "all"]);
  });

  it("pretty-prints without color codes when color is off", () => {
    const s = formatRecord(rec({}), { color: false });
    expect(s).toContain("INFO");
    expect(s).toContain("trigger.matched");
    expect(s).not.toContain("\x1b[");
    expect(formatRecord(rec({ level: "error" }), { color: true })).toContain("\x1b[31m");
  });
});

describe("JSONL logger", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "csl-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("writes ISO timestamps with a local offset", () => {
    expect(localIsoString(new Date())).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}[+-]\d\d:\d\d$/);
  });

  it("appends records in the documented shape and notifies listeners", () => {
    const file = path.join(dir, "a1b2c3.jsonl");
    const log = new Logger({ session: "a1b2c3", file });
    const seen: LogRecord[] = [];
    log.onRecord((r) => seen.push(r));
    log.info("trigger.matched", "hit", { trigger: "x" });
    const [line] = fs.readFileSync(file, "utf8").trim().split("\n");
    const r = JSON.parse(line);
    expect(Object.keys(r)).toEqual(["ts", "level", "session", "event", "msg", "data"]);
    expect(r.session).toBe("a1b2c3");
    expect(seen).toHaveLength(1);
  });

  it("rotates when the size limit is exceeded and keeps N files", () => {
    const file = path.join(dir, "a1b2c3.jsonl");
    const log = new Logger({ session: "a1b2c3", file, maxBytes: 400, keepFiles: 2 });
    for (let i = 0; i < 40; i++) log.info("command.injected", `line ${i} ${"x".repeat(40)}`);
    const names = fs.readdirSync(dir).sort();
    expect(names).toEqual(["a1b2c3.1.jsonl", "a1b2c3.2.jsonl", "a1b2c3.jsonl"]);
    for (const n of names) expect(fs.statSync(path.join(dir, n)).size).toBeLessThanOrEqual(400);
    // Oldest first, active last, newest record is in the active file
    const files = sessionLogFiles(file);
    expect(files.map((f) => path.basename(f))).toEqual(["a1b2c3.2.jsonl", "a1b2c3.1.jsonl", "a1b2c3.jsonl"]);
    const all = files.flatMap((f) => fs.readFileSync(f, "utf8").trim().split("\n"));
    expect(JSON.parse(all[all.length - 1]).msg).toMatch(/^line 39/);
  });
});
