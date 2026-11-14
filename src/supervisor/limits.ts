/**
 * Usage-limit messages: recognise them, and read the reset time.
 *
 * What Claude Code 2.1.325 prints (from its source):
 *   You've hit your 5-hour limit · resets 3:45pm (Asia/Kolkata)
 *   You've hit your weekly limit · resets Nov 15, 2am (Asia/Kolkata)
 *   You've hit your Opus limit · resets 3pm (Asia/Kolkata)
 *   You've hit your session limit · resets 12:10am
 * Times within 24 h are "h[:mm]am|pm"; later ones add "Mon D," (and the year when it
 * differs). The zone in parentheses is the one the time is written in. Older builds wrote
 * "Nov 15 at 2:00am"; that is accepted too. The same text is the StopFailure hook's
 * `last_assistant_message`, so one parser serves both the hook and the screen.
 */

export type LimitKind = "session" | "weekly" | "model" | "unknown";

export interface LimitInfo {
  kind: LimitKind;
  /** "5-hour limit", "weekly limit", "Opus limit", … or "usage limit". */
  label: string;
  /** For model limits: the model family that is capped ("opus", "sonnet", …). */
  model: string | null;
  /** The text after "resets", as written. */
  resetText: string | null;
  /** Parsed reset instant, or null when it couldn't be read. */
  resetAt: Date | null;
  /** The matched message line. */
  raw: string;
}

const LIMIT_LINE = /(You(?:'|’|’)ve hit your [^\n]{1,80}?limit[^\n]*|(?:Claude )?usage limit reached[^\n]*)/i;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function classify(label: string): { kind: LimitKind; model: string | null } {
  const l = label.toLowerCase();
  if (/5-hour|five.hour|session/.test(l)) return { kind: "session", model: null };
  if (/weekly|7-day|seven.day/.test(l)) return { kind: "weekly", model: null };
  const m = /\b(opus|sonnet|haiku|fable|mythos)\b/.exec(l);
  if (m) return { kind: "model", model: m[1] };
  return { kind: "unknown", model: null };
}

/** Find a usage-limit message in arbitrary text (a hook payload or cleaned screen text). */
export function findLimitMessage(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = LIMIT_LINE.exec(text);
  return m ? m[1].trim() : null;
}

/** Parse a limit message. Returns null when the text isn't a usage-limit message. */
export function parseLimitMessage(text: string | null | undefined, now: Date = new Date()): LimitInfo | null {
  const raw = findLimitMessage(text);
  if (!raw) return null;
  const hit = /hit your (.+?limit)\b/i.exec(raw);
  const label = hit ? hit[1].trim() : "usage limit";
  const { kind, model } = classify(label);
  const r = /\bresets?(?:\s+at)?\s+(.+?)(?:\s+·|\s+·|$)/i.exec(raw);
  const resetText = r ? r[1].trim().replace(/[.\s]+$/, "") : null;
  return { kind, label, model, resetText, resetAt: resetText ? parseResetTime(resetText, now) : null, raw };
}

function isValidZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock fields of `d` in zone `tz` (undefined = local). */
function wall(d: Date, tz?: string): { y: number; mo: number; d: number; h: number; mi: number } {
  if (!tz) return { y: d.getFullYear(), mo: d.getMonth(), d: d.getDate(), h: d.getHours(), mi: d.getMinutes() };
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get("year"), mo: get("month") - 1, d: get("day"), h: get("hour") % 24, mi: get("minute") };
}

/** The instant at which zone `tz` (undefined = local) shows the given wall-clock time. */
function fromWall(y: number, mo: number, d: number, h: number, mi: number, tz?: string): Date {
  if (!tz) return new Date(y, mo, d, h, mi, 0, 0);
  const want = Date.UTC(y, mo, d, h, mi);
  let t = want;
  // Two passes settle the offset, including across a DST change.
  for (let i = 0; i < 2; i++) {
    const w = wall(new Date(t), tz);
    const shown = Date.UTC(w.y, w.mo, w.d, w.h, w.mi);
    t += want - shown;
  }
  return new Date(t);
}

/**
 * Parse a reset time such as "3:45pm", "12:10am", "3pm (Asia/Kolkata)", "Nov 15, 2am",
 * "Nov 15 at 2:00am" or "Jan 2, 2027, 3pm". The time is read in the zone given in
 * parentheses, else in the local zone. A time of day that has already passed today
 * rolls forward 24 h; a date without a year that has passed means next year.
 */
export function parseResetTime(text: string, now: Date = new Date()): Date | null {
  let s = text.trim();
  let tz: string | undefined;
  const z = /\(([A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+)*)\)\s*$/.exec(s);
  if (z) {
    if (isValidZone(z[1])) tz = z[1];
    s = s.slice(0, z.index).trim();
  }
  s = s.replace(/ | /g, " ").replace(/\s+/g, " ");

  const time = /(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?$/i.exec(s) ?? /(\d{1,2}):(\d{2})$/.exec(s);
  if (!time) return null;
  let h = Number(time[1]);
  const mi = time[2] ? Number(time[2]) : 0;
  const ap = time[3]?.toLowerCase();
  if (mi > 59) return null;
  if (ap) {
    if (h < 1 || h > 12) return null;
    if (ap === "a" && h === 12) h = 0;
    if (ap === "p" && h !== 12) h += 12;
  } else if (h > 23) return null;

  const datePart = s.slice(0, time.index).replace(/(,|\bat)\s*$/i, "").replace(/,\s*$/, "").trim();
  const today = wall(now, tz);
  if (!datePart) {
    let t = fromWall(today.y, today.mo, today.d, h, mi, tz);
    if (t.getTime() <= now.getTime()) t = fromWall(today.y, today.mo, today.d + 1, h, mi, tz);
    return t;
  }
  const dm = /^([A-Za-z]{3,9})\.? (\d{1,2})(?:,? (\d{4}))?$/.exec(datePart);
  if (!dm) return null;
  const mo = MONTHS.indexOf(dm[1].slice(0, 3).toLowerCase());
  const day = Number(dm[2]);
  if (mo < 0 || day < 1 || day > 31) return null;
  if (dm[3]) return fromWall(Number(dm[3]), mo, day, h, mi, tz);
  let t = fromWall(today.y, mo, day, h, mi, tz);
  // "Jan 2" written on Dec 30 means next year; allow a day of slack for a reset that just passed.
  if (t.getTime() < now.getTime() - 86_400_000) t = fromWall(today.y + 1, mo, day, h, mi, tz);
  return t;
}

/** Model id or alias → family: "claude-opus-5-5" → "opus". Unknown stays as given (lowercased). */
export function modelFamily(model: string | null | undefined): string | null {
  if (!model) return null;
  const m = /\b(opus|sonnet|haiku|fable|mythos)\b/i.exec(model.replace(/[-_]/g, " "));
  return m ? m[1].toLowerCase() : model.toLowerCase();
}

/**
 * Turns raw PTY output into plain text lines and reports usage-limit messages it hasn't
 * reported recently. Cursor moves become spaces/newlines so words stay apart.
 */
export class PtyLimitScanner {
  private buf = "";
  private seen = new Map<string, number>();

  constructor(private readonly dedupeMs = 10 * 60_000) {}

  static clean(chunk: string): string {
    return chunk
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC
      .replace(/\x1b\[(\d*)C/g, (_m, n) => " ".repeat(Math.min(Number(n || 1), 200))) // cursor forward
      .replace(/\x1b\[[0-9;?]*[ABEFHfGd]/g, "\n") // cursor movement to another line/position
      .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, "") // other CSI (colors, erase, modes)
      .replace(/\x1b[()][A-Za-z0-9]|\x1b[=>78DEMc]/g, "")
      .replace(/\r\n?/g, "\n")
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
  }

  /** Feed raw output; returns newly seen, complete limit lines. */
  push(chunk: string, now = Date.now()): string[] {
    this.buf = (this.buf + PtyLimitScanner.clean(chunk)).slice(-4000);
    const out: string[] = [];
    const re = new RegExp(LIMIT_LINE.source + "\\n", "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(this.buf))) {
      const line = m[1].replace(/\s+/g, " ").trim();
      const last = this.seen.get(line);
      if (last !== undefined && now - last < this.dedupeMs) continue;
      this.seen.set(line, now);
      out.push(line);
    }
    // Keep only the unterminated tail so a line is never reported twice from the buffer.
    const nl = this.buf.lastIndexOf("\n");
    if (nl >= 0) this.buf = this.buf.slice(nl + 1);
    return out;
  }

  /** Whether `text` appeared on screen since `sinceMs` (e.g. "Set model to Sonnet"). */
  static includes(clean: string, needle: RegExp): boolean {
    return needle.test(clean);
  }
}

/** Phase named in /next's reply, e.g. "Phase 3: Auth" → "3: Auth". */
export function readPhase(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = /\bphase\s*[:#]?\s*([0-9]+[a-z]?(?:\.[0-9]+)*|[IVX]+\b|[A-Z]\b)(?:\s*(?:[:—–-]|\()\s*([^\n.()]{1,48}))?/i.exec(text);
  if (!m) return null;
  return m[2] ? `${m[1]}: ${m[2].trim().replace(/[*_`]+/g, "")}` : m[1];
}

/** True when `now` is inside `window` ("always" or "HH:MM-HH:MM", which may wrap midnight). */
export function insideActiveHours(window: string, now: Date = new Date()): boolean {
  if (window === "always") return true;
  const m = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(window);
  if (!m) return true;
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  const cur = now.getHours() * 60 + now.getMinutes();
  return start <= end ? cur >= start && cur < end : cur >= start || cur < end;
}
