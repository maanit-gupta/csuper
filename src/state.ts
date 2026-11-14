/** State snapshot shape (docs/dashboard-spec.md §6.3) — also the `csuper status --json` output. */
export interface DashState {
  session: {
    id: string;
    cwd: string;
    pid: number;
    claudePid: number;
    startedAt: string;
    version: string;
    /** Claude Code conversation ID this session was adopted from (`csuper adopt`). */
    adoptedFrom?: string | null;
  };
  autopilot: { enabled: boolean; pausedReason: PausedReason };
  model: string;
  cycles: CyclesState;
  activeHours: { window: string; inside: boolean };
  countdown: null | { trigger: string; firesAt: string; commands: string[] };
  rateLimit: {
    /** ok · waiting for a reset · resuming (resume sent, being verified) · failover (running on a fallback model) */
    status: "ok" | "waiting" | "resuming" | "failover";
    sessionResetAt: string | null;
    weeklyResetAt: string | null;
    /** Not yet sourced (see docs/dashboard-spec.md §9); stays null and renders as "—". */
    weeklyPct: number | null;
    /** Mirrors `weekly_quota_stop_pct` so the panel can draw the threshold. */
    weeklyStopPct?: number | null;
    resumeAt: string | null;
    caffeinatePid: number | null;
    /** Which limit: "5-hour limit", "weekly limit", "Opus limit", … or "unknown". */
    reason?: string | null;
    /** The raw limit message (truncated). */
    message?: string | null;
    /** Where the limit was first seen. */
    source?: "hook" | "pty" | null;
    detectedAt?: string | null;
    /** Reset time as parsed; null when it couldn't be read (then resumeAt is a backoff retry). */
    resetAt?: string | null;
    /** Start of the current wait (null when not waiting). */
    waitStartedAt?: string | null;
    /** Resumes sent in this wait episode. */
    resumeAttempts?: number;
    /** Consecutive resumes that hit the limit again (pauses at max_failed_resumes). */
    failedResumes?: number;
    /** Completed waits this session; add (now - waitStartedAt) for the live total. */
    totalWaitMs?: number;
    /** Resume time reached while autopilot was paused: resumes when autopilot resumes. */
    holding?: boolean;
    /** Model-specific limit (e.g. Opus) reset, and when to switch back at the next cycle boundary. */
    modelResetAt?: string | null;
    modelRestoreAt?: string | null;
    failovers?: Failover[];
  };
  triggers: { recent: Array<{ name: string; keyword: string; ts: string; commands: string[] }> };
  anomalies: {
    toolFailureStreak: number;
    threshold: number;
    editThrash: Record<string, number>;
    protectedViolations: string[];
    last: null | { kind: string; ts: string; actions: string[] };
  };
  git: { lastCheckpoint: null | { sha: string; ts: string; files: number }; stashes: string[] };
  handover: { path: string; mtime: string | null };
}

export type PausedReason = null | "user" | "blocked" | "anomaly" | "breaker" | "hours" | "cycle_failed" | "ratelimit" | "complete";

export interface Failover {
  ts: string;
  from: string;
  to: string;
  reason: string;
  /** When the switch back happened (null while still on the fallback model). */
  restoredAt: string | null;
}

/** One finished /clear→/next cycle. */
export interface CycleRecord {
  id: number;
  trigger: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  result: "ok" | "failed" | "cancelled";
  /** Step name the cycle failed or was cancelled at. */
  step: string | null;
  reason: string | null;
  /** Phase /next started, read from the reply (e.g. "3: Auth"), if any. */
  phase: string | null;
}

export interface CycleCurrent {
  id: number;
  trigger: string;
  startedAt: string;
  /** 1-based step number and total, e.g. 4 of 8. */
  step: number;
  total: number;
  name: string;
  label: string;
  stepStartedAt: string;
  /** When this step times out (null for steps without one, e.g. the countdown). */
  deadline: string | null;
}

export interface CyclesState {
  /** Successful cycles this session (counts toward max). */
  used: number;
  max: number;
  failed: number;
  lastOkAt: string | null;
  current: CycleCurrent | null;
  /** Last 10, oldest first. */
  recent: CycleRecord[];
}

export type DeepPartial<T> = T extends Array<any> ? T : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> | null } : T;

export function initialState(s: DashState["session"]): DashState {
  return {
    session: s,
    autopilot: { enabled: true, pausedReason: null },
    model: "opus",
    cycles: { used: 0, max: 0, failed: 0, lastOkAt: null, current: null, recent: [] },
    activeHours: { window: "always", inside: true },
    countdown: null,
    rateLimit: {
      status: "ok",
      sessionResetAt: null,
      weeklyResetAt: null,
      weeklyPct: null,
      weeklyStopPct: null,
      resumeAt: null,
      caffeinatePid: null,
      reason: null,
      message: null,
      source: null,
      detectedAt: null,
      resetAt: null,
      waitStartedAt: null,
      resumeAttempts: 0,
      failedResumes: 0,
      totalWaitMs: 0,
      holding: false,
      modelResetAt: null,
      modelRestoreAt: null,
      failovers: [],
    },
    triggers: { recent: [] },
    anomalies: { toolFailureStreak: 0, threshold: 0, editThrash: {}, protectedViolations: [], last: null },
    git: { lastCheckpoint: null, stashes: [] },
    handover: { path: `${s.cwd}/.claude/handover.md`, mtime: null },
  };
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Apply a `state.patch`: plain objects merge recursively; arrays, primitives and
 * null replace. Keys whose path is a free-form record (editThrash) are replaced
 * wholesale so removed files disappear.
 */
export function applyPatch<T>(target: T, patch: unknown, path: string[] = []): T {
  if (!isPlainObject(patch) || !isPlainObject(target)) return patch as T;
  const out: Record<string, unknown> = { ...target };
  for (const [k, v] of Object.entries(patch)) {
    const p = [...path, k].join(".");
    if (p === "anomalies.editThrash") out[k] = v;
    else if (isPlainObject(v) && isPlainObject(out[k])) out[k] = applyPatch(out[k], v, [...path, k]);
    else out[k] = v;
  }
  return out as T;
}
