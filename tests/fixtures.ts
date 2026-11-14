import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initialState, type DashState } from "../src/state.js";

export function tmpHome(prefix = "cs-"): string {
  // Keep paths short: macOS limits Unix socket paths to 104 bytes.
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Fixed timestamps so countdown/snapshot rendering is deterministic. */
export const NOW = Date.parse("2026-11-14T07:30:00.000Z");
export const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

export function sampleState(over: Partial<DashState> = {}): DashState {
  const s = initialState({
    id: "a1b2c3",
    cwd: "/Users/dev/proj",
    pid: 4242,
    claudePid: 4243,
    startedAt: iso(-(2 * 3600e3 + 5 * 60e3)),
    version: "0.1.0",
  });
  return {
    ...s,
    model: "opus",
    cycles: {
      used: 3,
      max: 20,
      failed: 1,
      lastOkAt: iso(-4 * 60e3),
      current: {
        id: 5,
        trigger: "task_complete",
        startedAt: iso(-4_000),
        step: 2,
        total: 8,
        name: "countdown",
        label: "countdown",
        stepStartedAt: iso(-1_000),
        deadline: null,
      },
      recent: [
        { id: 1, trigger: "task_complete", startedAt: iso(-40 * 60e3), endedAt: iso(-40 * 60e3 + 41e3), durationMs: 41e3, result: "ok", step: null, reason: null, phase: "1: Setup" },
        { id: 2, trigger: "task_complete", startedAt: iso(-25 * 60e3), endedAt: iso(-25 * 60e3 + 35e3), durationMs: 35e3, result: "failed", step: "clear_confirmed", reason: "no confirmation within 30 s", phase: null },
        { id: 3, trigger: "task_complete", startedAt: iso(-12 * 60e3), endedAt: iso(-12 * 60e3 + 3e3), durationMs: 3e3, result: "cancelled", step: "countdown", reason: "cancelled by user", phase: null },
        { id: 4, trigger: "task_complete", startedAt: iso(-5 * 60e3), endedAt: iso(-4 * 60e3), durationMs: 60e3, result: "ok", step: null, reason: null, phase: "3: Auth refactor" },
      ],
    },
    activeHours: { window: "09:00-23:00", inside: true },
    countdown: { trigger: "task_complete", firesAt: iso(4_000), commands: ["/clear", "/next"] },
    rateLimit: {
      status: "ok",
      sessionResetAt: iso(3600e3 + 12 * 60e3),
      weeklyResetAt: iso(3 * 86400e3 + 4 * 3600e3),
      weeklyPct: null,
      weeklyStopPct: 90,
      resumeAt: null,
      caffeinatePid: 5150,
      reason: "5-hour limit",
      message: "You've hit your 5-hour limit · resets 8:42am",
      source: "hook",
      detectedAt: iso(-3 * 3600e3),
      resetAt: iso(-2 * 3600e3),
      waitStartedAt: null,
      resumeAttempts: 0,
      failedResumes: 0,
      totalWaitMs: 3600e3 + 31 * 60e3,
      holding: false,
      modelResetAt: null,
      modelRestoreAt: null,
      failovers: [],
    },
    triggers: {
      // Oldest first, as the daemon appends
      recent: [
        { name: "handover", keyword: "::HANDOVER::", ts: iso(-20 * 60e3), commands: ["/compact"] },
        { name: "task_complete", keyword: "::DONE::", ts: iso(-60e3), commands: ["/clear", "/next"] },
      ],
    },
    anomalies: {
      toolFailureStreak: 1,
      threshold: 5,
      editThrash: { "src/app.ts": 3 },
      protectedViolations: [],
      last: { kind: "tool_failure_streak", ts: iso(-3600e3), actions: ["git stash", "/clear"] },
    },
    git: { lastCheckpoint: { sha: "9f3c2ab", ts: iso(-5 * 60e3), files: 4 }, stashes: ["stash@{0}: csuper-anomaly-recovery 2026-11-14"] },
    handover: { path: "/Users/dev/proj/.claude/handover.md", mtime: iso(-10 * 60e3) },
    ...over,
  };
}
