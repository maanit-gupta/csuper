import type { CycleRecord, DashState } from "../state.js";
import { formatTime } from "../log-filter.js";

/** Compact duration: 45s, 12m 05s, 3h 12m, 2d 4h. Negative values clamp to 0s. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

/** Countdowns come from absolute timestamps, never decrementing counters (docs/dashboard-spec.md §8.4). */
export function untilIso(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  return t <= now ? "now" : formatDuration(t - now);
}

export function sinceIso(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  return `${formatDuration(now - t)} ago`;
}

export function clock(iso: string | null | undefined, fmt: "24h" | "12h" = "24h"): string {
  return iso ? formatTime(iso, fmt) : "—";
}

export type AutopilotLabel = "ON" | "OFF" | "PAUSED";
/** ON when running; PAUSED when stopped for a reason (user/blocked/anomaly/breaker/hours); OFF otherwise. */
export function autopilotLabel(s: DashState): AutopilotLabel {
  if (s.autopilot.enabled) return "ON";
  return s.autopilot.pausedReason ? "PAUSED" : "OFF";
}

export function shortenHome(p: string): string {
  const home = process.env.HOME;
  return home && p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

/** Text bar for percentages, e.g. [██████░░░░] 60%. */
export function bar(pct: number | null, width = 20): string {
  if (pct === null || Number.isNaN(pct)) return `[${"·".repeat(width)}] —`;
  const p = Math.max(0, Math.min(100, pct));
  const filled = Math.round((p / 100) * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}] ${Math.round(p)}%`;
}

export function cycleOutcome(r: CycleRecord): string {
  return r.result === "ok" ? "ok" : `${r.result}${r.step ? ` at ${r.step}` : ""}`;
}

function cycleNow(s: DashState, now: number): string {
  const c = s.cycles.current;
  if (!c) return "idle";
  return `${c.step}/${c.total} ${c.label}${c.deadline ? ` (times out in ${untilIso(c.deadline, now)})` : ""}`;
}

/** Multi-line plain-text summary used by `csuper status`. */
export function statusText(s: DashState, now = Date.now(), fmt: "24h" | "12h" = "24h"): string {
  const rl = s.rateLimit;
  const lines = [
    `session   ${s.session.id}  ${shortenHome(s.session.cwd)}  (pid ${s.session.pid}, claude ${s.session.claudePid}, up ${formatDuration(now - Date.parse(s.session.startedAt))})${s.session.adoptedFrom ? `  adopted from ${s.session.adoptedFrom.slice(0, 8)}` : ""}`,
    `autopilot ${autopilotLabel(s)}${s.autopilot.pausedReason ? ` (${s.autopilot.pausedReason})` : ""}  model ${s.model}  cycles ${s.cycles.used}/${s.cycles.max}  hours ${s.activeHours.window} (${s.activeHours.inside ? "inside" : "outside"})`,
    `cycles    ${s.cycles.used}/${s.cycles.max} ok · ${s.cycles.failed} failed · last ok ${s.cycles.lastOkAt ? `${clock(s.cycles.lastOkAt, fmt)} (${sinceIso(s.cycles.lastOkAt, now)})` : "—"}  now ${cycleNow(s, now)}`,
  ];
  for (const r of s.cycles.recent.slice(-10).reverse()) lines.push(`          #${r.id} ${clock(r.startedAt, fmt)} ${formatDuration(r.durationMs).padEnd(7)} ${cycleOutcome(r)}${r.phase ? `  phase ${r.phase}` : ""}`);
  const waited = (rl.totalWaitMs ?? 0) + (rl.waitStartedAt ? Math.max(0, now - Date.parse(rl.waitStartedAt)) : 0);
  lines.push(
    `ratelimit ${rl.status}${rl.reason ? ` (${rl.status === "ok" || rl.status === "failover" ? "last: " : ""}${rl.reason})` : ""}${rl.resetAt ? `  resets ${clock(rl.resetAt, fmt)} (${untilIso(rl.resetAt, now)})` : ""}${rl.resumeAt ? `  resume at ${clock(rl.resumeAt, fmt)} (in ${untilIso(rl.resumeAt, now)})` : ""}  resumes ${rl.resumeAttempts ?? 0} sent, ${rl.failedResumes ?? 0} failed in a row  waited ${formatDuration(waited)}  caffeinate ${rl.caffeinatePid ? `pid ${rl.caffeinatePid}` : "off"}`,
    `          5h reset ${untilIso(rl.sessionResetAt, now)}  weekly reset ${untilIso(rl.weeklyResetAt, now)}  weekly ${rl.weeklyPct === null ? "—" : `${Math.round(rl.weeklyPct)}%`}${(rl.failovers ?? []).length ? `  failovers ${(rl.failovers ?? []).map((f) => `${f.from}→${f.to} ${clock(f.ts, fmt)}${f.restoredAt ? ` (back ${clock(f.restoredAt, fmt)})` : ""}`).join(", ")}` : ""}`,
  );
  if (s.countdown) lines.push(`countdown ${s.countdown.commands.join(" ")} in ${untilIso(s.countdown.firesAt, now)} (${s.countdown.trigger})`);
  const a = s.anomalies;
  lines.push(`anomalies tool-fail streak ${a.toolFailureStreak}/${a.threshold}  protected violations ${a.protectedViolations.length}${a.last ? `  last ${a.last.kind} ${sinceIso(a.last.ts, now)}` : ""}`);
  if (s.git.lastCheckpoint) lines.push(`git       checkpoint ${s.git.lastCheckpoint.sha} ${sinceIso(s.git.lastCheckpoint.ts, now)} (${s.git.lastCheckpoint.files} files)  stashes ${s.git.stashes.length}`);
  return lines.join("\n");
}
