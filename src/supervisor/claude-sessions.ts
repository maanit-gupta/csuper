/**
 * Read Claude Code's own session storage so an existing conversation can be resumed
 * under csuper (`csuper resume`).
 *
 *   ~/.claude/projects/<cwd-slug>/<uuid>.jsonl   one transcript per conversation
 *   ~/.claude/sessions/<pid>.json                {pid, sessionId, cwd, …} for each running claude
 *
 * `CLAUDE_CONFIG_DIR` overrides `~/.claude`, as it does for Claude Code itself.
 * Everything here is read-only and tolerant of format drift: unknown or malformed
 * lines are skipped, never fatal.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ClaudeSession {
  id: string;
  file: string;
  cwd: string;
  /** Last write to the transcript (ISO). */
  updatedAt: string;
  /** Transcript size in bytes. */
  size: number;
  /** First thing the user typed, single-lined; "" if none was found in the head of the file. */
  firstPrompt: string;
  /** Title Claude Code gave the conversation, when the transcript records one. */
  title: string | null;
  gitBranch: string | null;
  /** PID of a running `claude` that has this conversation open, if any. */
  livePid: number | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isClaudeSessionId(s: string): boolean {
  return UUID_RE.test(s);
}

export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

/** Claude Code names a project's folder after its cwd with every non-alphanumeric replaced by "-". */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/** Bytes read from the start of each transcript to find the first prompt and title. */
const HEAD_BYTES = 256 * 1024;

function readHead(file: string, bytes = HEAD_BYTES): string {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

/** Turn a raw user message into one readable line ("/run args" for slash commands). */
export function promptText(content: unknown): string {
  let text = "";
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    // Tool results also arrive as "user" messages; only real text counts as a prompt.
    if (content.some((c) => c && typeof c === "object" && (c as any).type === "tool_result")) return "";
    text = content
      .filter((c) => c && typeof c === "object" && (c as any).type === "text" && typeof (c as any).text === "string")
      .map((c) => (c as any).text as string)
      .join(" ");
  }
  if (!text) return "";
  const cmd = /<command-name>([^<]*)<\/command-name>/.exec(text);
  if (cmd) {
    const args = /<command-args>([^<]*)<\/command-args>/.exec(text)?.[1]?.trim();
    return [cmd[1].trim(), args].filter(Boolean).join(" ");
  }
  // Output of `!` shell commands and other harness-injected blocks aren't prompts.
  if (/^\s*<(local-command|bash-|system-reminder|task-notification)/.test(text)) return "";
  return text
    .replace(/<\/?pasted_content[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface TranscriptSummary {
  cwd: string | null;
  firstPrompt: string;
  title: string | null;
  gitBranch: string | null;
}

/** Pull cwd, first prompt and title out of the first lines of a transcript. */
export function summarizeTranscript(head: string): TranscriptSummary {
  const out: TranscriptSummary = { cwd: null, firstPrompt: "", title: null, gitBranch: null };
  // Slash commands (/model, /clear, …) say little about a conversation; prefer typed text.
  let firstCommand = "";
  for (const line of head.split("\n")) {
    if (!line.trim()) continue;
    let r: any;
    try {
      r = JSON.parse(line);
    } catch {
      continue; // probably the partial last line of the head
    }
    if (!r || typeof r !== "object") continue;
    if (!out.cwd && typeof r.cwd === "string") out.cwd = r.cwd;
    if (!out.gitBranch && typeof r.gitBranch === "string" && r.gitBranch) out.gitBranch = r.gitBranch;
    if ((r.type === "custom-title" || r.type === "ai-title") && typeof (r.customTitle ?? r.aiTitle ?? r.title) === "string") {
      // A user-set title wins over a generated one.
      if (r.type === "custom-title" || !out.title) out.title = r.customTitle ?? r.aiTitle ?? r.title;
    }
    if (r.type === "summary" && typeof r.summary === "string" && !out.title) out.title = r.summary;
    if (!out.firstPrompt && r.type === "user" && !r.isSidechain && !r.isMeta && r.message) {
      const t = promptText(r.message.content);
      if (t.startsWith("/")) firstCommand ||= t;
      else out.firstPrompt = t;
    }
  }
  if (!out.firstPrompt) out.firstPrompt = firstCommand;
  return out;
}

export function claudeSessionsDir(): string {
  return path.join(claudeConfigDir(), "sessions");
}

/** Registry file a running claude keeps for itself (see `liveClaudeSessions`). */
export function claudeRegistryFile(pid: number, dir = claudeSessionsDir()): string {
  return path.join(dir, `${pid}.json`);
}

/**
 * Map of conversation ID → PID for every `claude` currently running.
 *
 * Source: ~/.claude/sessions/<pid>.json, which each running claude writes as
 * {pid, sessionId, cwd, status, …} and removes when it exits. This registry is
 * UNDOCUMENTED Claude Code internals (observed in 2.1.325) and may change or vanish;
 * a missing or unreadable directory yields an empty map, never an error, and callers
 * fall back to the process scan in `detectLiveClaudes`.
 */
export function liveClaudeSessions(dir = claudeSessionsDir()): Map<string, number> {
  const live = new Map<string, number>();
  for (const e of readClaudeRegistry(dir)) live.set(e.sessionId, e.pid);
  return live;
}

export interface ClaudeRegistryEntry {
  pid: number;
  sessionId: string;
  cwd: string | null;
}

/** Live entries of ~/.claude/sessions (undocumented; see above). Never throws. */
export function readClaudeRegistry(dir = claudeSessionsDir()): ClaudeRegistryEntry[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const out: ClaudeRegistryEntry[] = [];
  for (const n of names) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"));
      if (typeof j.sessionId !== "string" || typeof j.pid !== "number") continue;
      if (!pidAlive(j.pid)) continue;
      out.push({ pid: j.pid, sessionId: j.sessionId, cwd: typeof j.cwd === "string" ? j.cwd : null });
    } catch {
      /* skip unreadable entries */
    }
  }
  return out;
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface ClaudeProcess {
  pid: number;
  ppid: number;
  cwd: string | null;
}

/** Is this `ps` args line an interactive claude CLI (not the Chrome native host etc.)? */
export function isClaudeCommand(args: string): boolean {
  const argv0 = args.trim().split(/\s+/)[0] ?? "";
  const base = path.basename(argv0);
  const isClaude = base === "claude" || /\/claude\/versions\/[^/]+$/.test(argv0);
  return isClaude && !/\s--chrome-native-host\b/.test(args);
}

/** Parse `ps -A -o pid=,ppid=,args=`. */
export function parsePs(text: string): Array<{ pid: number; ppid: number; args: string }> {
  const out: Array<{ pid: number; ppid: number; args: string }> = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3] });
  }
  return out;
}

/** Parse `lsof -a -d cwd -p <pids> -Fpn` into pid → cwd. */
export function parseLsofCwd(text: string): Map<number, string> {
  const out = new Map<number, string>();
  let pid = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid) out.set(pid, line.slice(1));
  }
  return out;
}

function run(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
  } catch (e) {
    // lsof exits 1 when some pids vanished but still prints the rest.
    return ((e as { stdout?: string }).stdout ?? "").toString();
  }
}

/** Fallback scan: every running claude CLI and its cwd, via ps + lsof. Never throws. */
export function scanClaudeProcesses(): ClaudeProcess[] {
  const procs = parsePs(run("ps", ["-A", "-o", "pid=,ppid=,args="])).filter((p) => isClaudeCommand(p.args) && p.pid !== process.pid);
  if (procs.length === 0) return [];
  const cwds = parseLsofCwd(run("lsof", ["-a", "-d", "cwd", "-p", procs.map((p) => p.pid).join(","), "-Fpn"]));
  return procs.map((p) => ({ pid: p.pid, ppid: p.ppid, cwd: cwds.get(p.pid) ?? null }));
}

export interface LiveClaudes {
  /** Exact matches from the registry: conversation ID → pid. */
  bySession: Map<string, number>;
  /** Running claudes with no registry entry. Any conversation in their cwd is "possibly live". */
  unmatched: ClaudeProcess[];
}

/**
 * Everything we know about running claudes. The registry gives exact
 * session → pid matches; ps + lsof catches claudes the registry doesn't list
 * (older/newer Claude Code, child sessions with saving off, registry missing).
 */
export function detectLiveClaudes(opts: { sessionsDir?: string; scan?: () => ClaudeProcess[] } = {}): LiveClaudes {
  const entries = readClaudeRegistry(opts.sessionsDir);
  const bySession = new Map(entries.map((e) => [e.sessionId, e.pid]));
  const known = new Set(entries.map((e) => e.pid));
  // CSUPER_CLAUDE_SCAN=off: registry only (the e2e suite uses a fake ~/.claude, so the
  // real claudes on the machine would otherwise look like unregistered ones).
  const scan = opts.scan ?? (process.env.CSUPER_CLAUDE_SCAN === "off" ? () => [] : scanClaudeProcesses);
  const unmatched = scan().filter((p) => !known.has(p.pid));
  return { bySession, unmatched };
}

export type AdoptStatus = "live" | "possibly live" | "ended" | "already csuper";

/** csuper's own view of the claudes it supervises (from ~/.csuper/sessions/*.json). */
export interface SupervisedClaude {
  csuperId: string;
  claudePid: number;
  claudeSessionId: string | null;
}

/**
 * Classify one conversation. `pid` is the process to stop for live ones
 * (null when ended, or when several unmatched claudes share the cwd).
 */
export function classifySession(
  s: { id: string; cwd: string },
  live: LiveClaudes,
  supervised: SupervisedClaude[],
): { status: AdoptStatus; pid: number | null; csuperId: string | null; candidates: number[] } {
  const exact = live.bySession.get(s.id) ?? null;
  const sup =
    supervised.find((c) => c.claudeSessionId === s.id && pidAlive(c.claudePid)) ??
    (exact !== null ? supervised.find((c) => c.claudePid === exact) : undefined);
  if (sup) return { status: "already csuper", pid: sup.claudePid, csuperId: sup.csuperId, candidates: [sup.claudePid] };
  if (exact !== null) return { status: "live", pid: exact, csuperId: null, candidates: [exact] };
  const same = live.unmatched.filter((p) => p.cwd === s.cwd).map((p) => p.pid);
  if (same.length) return { status: "possibly live", pid: same.length === 1 ? same[0] : null, csuperId: null, candidates: same };
  return { status: "ended", pid: null, csuperId: null, candidates: [] };
}

/** Folder holding this cwd's transcripts, or null when Claude Code has never run here. */
export function projectDirFor(cwd: string, projectsRoot = path.join(claudeConfigDir(), "projects")): string | null {
  const direct = path.join(projectsRoot, projectSlug(cwd));
  if (fs.existsSync(direct)) return direct;
  // Very long paths get shortened by Claude Code; fall back to a prefix match + cwd check.
  const prefix = projectSlug(cwd).slice(0, 80);
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(projectsRoot).filter((d) => d.startsWith(prefix));
  } catch {
    return null;
  }
  for (const d of dirs) {
    const full = path.join(projectsRoot, d);
    const first = fs.readdirSync(full).find((f) => f.endsWith(".jsonl"));
    if (first && summarizeTranscript(readHead(path.join(full, first), 64 * 1024)).cwd === cwd) return full;
  }
  return null;
}

interface TranscriptFile {
  id: string;
  file: string;
  mtimeMs: number;
  size: number;
}

/** Non-empty `<uuid>.jsonl` files in one project folder. */
function transcriptFiles(dir: string): TranscriptFile[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: TranscriptFile[] = [];
  for (const name of names) {
    const id = name.replace(/\.jsonl$/, "");
    if (!name.endsWith(".jsonl") || !isClaudeSessionId(id)) continue;
    const file = path.join(dir, name);
    try {
      const st = fs.statSync(file);
      if (st.isFile() && st.size > 0) out.push({ id, file, mtimeMs: st.mtimeMs, size: st.size });
    } catch {
      /* vanished */
    }
  }
  return out;
}

/** Summarize transcripts newest first, skipping ones with nothing to resume, until `limit`. */
function toSessions(files: TranscriptFile[], live: Map<string, number>, fallbackCwd: (f: TranscriptFile) => string, limit = Infinity): ClaudeSession[] {
  const out: ClaudeSession[] = [];
  for (const f of [...files].sort((a, b) => b.mtimeMs - a.mtimeMs)) {
    if (out.length >= limit) break;
    let s: TranscriptSummary;
    try {
      s = summarizeTranscript(readHead(f.file));
    } catch {
      continue;
    }
    // Transcripts with no prompt at all (e.g. opened and closed) have nothing to resume.
    if (!s.firstPrompt && !s.title) continue;
    out.push({
      id: f.id,
      file: f.file,
      cwd: s.cwd ?? fallbackCwd(f),
      updatedAt: new Date(f.mtimeMs).toISOString(),
      size: f.size,
      firstPrompt: s.firstPrompt,
      title: s.title,
      gitBranch: s.gitBranch,
      livePid: live.get(f.id) ?? null,
    });
  }
  return out;
}

/** Every resumable conversation recorded for `cwd`, newest first. */
export function listClaudeSessions(cwd: string, opts: { projectsRoot?: string; sessionsDir?: string } = {}): ClaudeSession[] {
  const dir = projectDirFor(cwd, opts.projectsRoot);
  if (!dir) return [];
  return toSessions(transcriptFiles(dir), liveClaudeSessions(opts.sessionsDir), () => cwd);
}

/**
 * Resumable conversations across every project, newest first, at most `limit`.
 * With `id`, returns only conversations whose ID starts with it (any age);
 * with `only`, just those IDs.
 */
export function listAllClaudeSessions(opts: { projectsRoot?: string; sessionsDir?: string; limit?: number; id?: string; only?: Set<string> } = {}): ClaudeSession[] {
  const root = opts.projectsRoot ?? path.join(claudeConfigDir(), "projects");
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return [];
  }
  let files: TranscriptFile[] = [];
  for (const d of dirs) files.push(...transcriptFiles(path.join(root, d)));
  if (opts.id) files = files.filter((f) => f.id.toLowerCase().startsWith(opts.id!.toLowerCase()));
  if (opts.only) files = files.filter((f) => opts.only!.has(f.id));
  // A project folder name is a lossy slug of its cwd; the transcript's own cwd is preferred.
  return toSessions(files, liveClaudeSessions(opts.sessionsDir), (f) => path.basename(path.dirname(f.file)), opts.limit);
}

/** Find one conversation by full UUID or unique prefix (like `git` short SHAs). */
export function findClaudeSession(sessions: ClaudeSession[], idOrPrefix: string): ClaudeSession | "ambiguous" | null {
  const q = idOrPrefix.toLowerCase();
  const hits = sessions.filter((s) => s.id.toLowerCase().startsWith(q));
  if (hits.length === 1) return hits[0];
  return hits.length > 1 ? "ambiguous" : null;
}
