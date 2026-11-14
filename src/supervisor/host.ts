/**
 * Side effects the autopilot engine asks for: macOS notifications, caffeinate, git
 * checkpoints, handover copies and the raw rate-limit sample file. None of them writes
 * to stdout/stderr (the PTY owns the terminal); failures are returned or logged.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { localIsoString } from "../logger.js";
import { ensurePrivateDir, logsDir } from "../paths.js";

/** AppleScript string literal. */
export function appleString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ")}"`;
}

/**
 * Fire-and-forget macOS notification (osascript, no shell). With CSUPER_NOTIFY_LOG set,
 * notifications are appended to that file instead (used by the e2e suite).
 */
export function notifyMac(title: string, message: string): void {
  const sink = process.env.CSUPER_NOTIFY_LOG;
  if (sink) {
    try {
      fs.appendFileSync(sink, JSON.stringify({ ts: localIsoString(), title, message }) + "\n");
    } catch {
      /* best effort */
    }
    return;
  }
  try {
    const p = execFile("osascript", ["-e", `display notification ${appleString(message.slice(0, 240))} with title ${appleString(title.slice(0, 80))}`], { timeout: 10_000 }, () => {});
    p.unref?.();
  } catch {
    /* notifications are best effort */
  }
}

/** `caffeinate -i -w <our pid>`: it also exits by itself if csuper dies. */
export class Caffeinate {
  private child: ChildProcess | null = null;
  constructor(private readonly bin = "caffeinate") {}
  start(): number | null {
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.child.pid ?? null;
    try {
      const c = spawn(this.bin, ["-i", "-w", String(process.pid)], { stdio: "ignore" });
      c.on("error", () => {
        if (this.child === c) this.child = null;
      });
      c.on("exit", () => {
        if (this.child === c) this.child = null;
      });
      c.unref();
      this.child = c;
      return c.pid ?? null;
    } catch {
      return null;
    }
  }
  stop(): void {
    const c = this.child;
    this.child = null;
    if (c && c.exitCode === null) {
      try {
        c.kill("SIGTERM");
      } catch {
        /* gone */
      }
    }
  }
  get pid(): number | null {
    return this.child?.pid ?? null;
  }
}

function git(cwd: string, args: string[], timeout = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).toString().trim().split("\n")[0]));
      else resolve(stdout.toString());
    });
  });
}

/** `chore(csuper): checkpoint (<trigger>)` when the tree is dirty; null when clean or not a repo. */
export async function gitCheckpoint(cwd: string, trigger: string): Promise<{ sha: string; files: number } | null> {
  try {
    if ((await git(cwd, ["rev-parse", "--is-inside-work-tree"])).trim() !== "true") return null;
  } catch {
    return null;
  }
  if (!(await git(cwd, ["status", "--porcelain"])).trim()) return null;
  await git(cwd, ["add", "-A"]);
  const files = (await git(cwd, ["diff", "--cached", "--name-only"])).split("\n").filter(Boolean).length;
  if (files === 0) return null;
  await git(cwd, ["commit", "-q", "-m", `chore(csuper): checkpoint (${trigger})`], 60_000);
  const sha = (await git(cwd, ["rev-parse", "--short", "HEAD"])).trim();
  return { sha, files };
}

/** Copy claude's final message to <cwd>/.claude/csuper-handovers/<time>-<trigger>.md (git-ignored; never touches handover.md). */
export function saveHandover(cwd: string, text: string, trigger: string): string | null {
  try {
    const dir = path.join(cwd, ".claude", "csuper-handovers");
    fs.mkdirSync(dir, { recursive: true });
    // csuper's own copies stay out of the project's git history (and its checkpoints).
    const ignore = path.join(dir, ".gitignore");
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n");
    const stamp = localIsoString().slice(0, 19).replace(/[:T]/g, "-");
    const file = path.join(dir, `${stamp}-${trigger}.md`);
    fs.writeFileSync(file, text.endsWith("\n") ? text : text + "\n");
    return file;
  } catch {
    return null;
  }
}

/** Every raw limit message, so the parser can be fixed against real text. */
export function sampleWriter(session: string, file = path.join(logsDir(), "ratelimit-samples.jsonl")) {
  return (rec: Record<string, unknown>) => {
    try {
      ensurePrivateDir(path.dirname(file));
      fs.appendFileSync(file, JSON.stringify({ ts: localIsoString(), session, ...rec }) + "\n", { mode: 0o600 });
    } catch {
      /* best effort */
    }
  };
}
