import { resolveSession, type SessionEntry } from "../session-registry.js";
import { shortenHome } from "./format.js";

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
}

export const stdio: Io = {
  out: (s) => process.stdout.write(s.endsWith("\n") ? s : s + "\n"),
  err: (s) => process.stderr.write(s.endsWith("\n") ? s : s + "\n"),
};

export function sessionLine(s: SessionEntry): string {
  const cwd = s.info ? shortenHome(s.info.cwd) : "?";
  const started = s.info?.started_at ?? "?";
  return `${s.id}  ${s.status.padEnd(5)}  ${cwd}  started ${started}${s.staleReason ? `  (${s.staleReason})` : ""}`;
}

/**
 * Shared session resolution for one-shot commands. Returns the session or the
 * exit code to use (2 = not found / ambiguous) after printing why.
 */
export async function pickSession(id: string | undefined, io: Io, dir?: string): Promise<SessionEntry | number> {
  const r = await resolveSession(id, dir);
  if (r.kind === "ok") return r.session;
  if (r.kind === "ambiguous") {
    io.err("csuper: several live sessions; pass --session <id>:");
    for (const s of r.sessions) io.err("  " + sessionLine(s));
    return 2;
  }
  io.err(r.id ? `csuper: session not found: ${r.id}` : "csuper: no live csuper session found");
  return 2;
}
