import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Expand a leading `~` to the user's home directory. */
export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Root for sockets, registry and logs. `CSUPER_HOME` overrides `~/.csuper`. */
export function csuperHome(): string {
  return expandHome(process.env.CSUPER_HOME || "~/.csuper");
}

export function sessionsDir(home = csuperHome()): string {
  return path.join(home, "sessions");
}

export function logsDir(home = csuperHome()): string {
  return path.join(home, "logs");
}

/** Create a directory (recursively) and force owner-only permissions (docs/dashboard-spec.md §5.4). */
export function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

/** Ensure `~/.csuper`, `sessions/` and `logs/` exist with mode 0700. */
export function ensureHome(home = csuperHome()): void {
  ensurePrivateDir(home);
  ensurePrivateDir(sessionsDir(home));
  ensurePrivateDir(logsDir(home));
}
