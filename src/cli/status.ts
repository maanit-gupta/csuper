import type { DashState } from "../state.js";
import { fetchSnapshot } from "./client.js";
import { pickSession, stdio, type Io } from "./common.js";
import { statusText } from "./format.js";

/** `csuper status` exit codes (docs/dashboard-spec.md §4.3). */
export const EXIT = { OK: 0, PAUSED_OR_WAITING: 1, NOT_FOUND: 2, ANOMALY: 3, STALE: 4 } as const;

/**
 * Map a snapshot to an exit code. More severe states win:
 * anomaly/breaker (3) > paused or rate-limit wait (1) > ok (0).
 */
export function exitCodeFor(s: DashState): number {
  const r = s.autopilot.pausedReason;
  // Needs a person: anomaly, a tripped breaker, a failed cycle, or a rate limit csuper gave up resuming.
  if (r === "anomaly" || r === "breaker" || r === "cycle_failed" || r === "ratelimit") return EXIT.ANOMALY;
  if (!s.autopilot.enabled || s.rateLimit.status === "waiting") return EXIT.PAUSED_OR_WAITING;
  return EXIT.OK;
}

export interface StatusOpts {
  session?: string;
  json?: boolean;
  timeFormat?: "24h" | "12h";
  sessionsDir?: string;
}

export async function runStatus(opts: StatusOpts, io: Io = stdio): Promise<number> {
  const picked = await pickSession(opts.session, io, opts.sessionsDir);
  if (typeof picked === "number") return picked;
  if (picked.status === "stale") {
    io.err(`csuper: session ${picked.id} is not responding (stale: ${picked.staleReason}); run \`csuper sessions --prune\``);
    return EXIT.STALE;
  }
  let state: DashState;
  try {
    ({ state } = await fetchSnapshot(picked.sockPath));
  } catch (e: any) {
    io.err(`csuper: session ${picked.id} is not responding (${e?.code ?? e?.message})`);
    return EXIT.STALE;
  }
  io.out(opts.json ? JSON.stringify(state, null, 2) : statusText(state, Date.now(), opts.timeFormat));
  return exitCodeFor(state);
}
