import { listSessions, pruneStale } from "../session-registry.js";
import { sessionLine, stdio, type Io } from "./common.js";

export interface SessionsOpts {
  json?: boolean;
  prune?: boolean;
  sessionsDir?: string;
}

export async function runSessions(opts: SessionsOpts, io: Io = stdio): Promise<number> {
  if (opts.prune) {
    const removed = await pruneStale(opts.sessionsDir);
    if (opts.json) io.out(JSON.stringify({ pruned: removed }));
    else io.out(removed.length ? `pruned ${removed.length} stale session(s): ${removed.join(", ")}` : "no stale sessions");
    return 0;
  }
  const sessions = await listSessions(opts.sessionsDir);
  if (opts.json) {
    io.out(
      JSON.stringify(
        sessions.map((s) => ({ id: s.id, status: s.status, staleReason: s.staleReason ?? null, sock: s.sockPath, ...(s.info ?? {}) })),
        null,
        2,
      ),
    );
    return 0;
  }
  if (!sessions.length) {
    io.out("no csuper sessions");
    return 0;
  }
  for (const s of sessions) io.out(sessionLine(s));
  return 0;
}
