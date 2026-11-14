/**
 * Autopilot engine against a stub claude, on fake timers (nothing really waits).
 * vitest runs with TZ=UTC, so "local time" below is UTC.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cycleSteps, lastLine, matchTrigger } from "../src/supervisor/autopilot.js";
import { parseLimitMessage, parseResetTime } from "../src/supervisor/limits.js";
import { defaultConfig } from "../src/config.js";
import { BANNER, StubClaude, type StubOptions } from "./stub-claude.js";

const T0 = "2026-11-14T12:00:00.000Z"; // a Saturday, noon (UTC = local in tests)
const sec = (n: number) => n * 1000;
const min = (n: number) => n * 60_000;
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

function stub(o: StubOptions = {}) {
  return new StubClaude(o);
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date(T0) });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("trigger matching (last line only)", () => {
  const triggers = defaultConfig().triggers;
  it("matches the keyword on the last non-empty line", () => {
    expect(matchTrigger(triggers, "All tests pass.\n\n::DONE::\n")?.name).toBe("task_complete");
    expect(matchTrigger(triggers, "Done with phase 2. `::DONE::`")?.name).toBe("task_complete");
    expect(matchTrigger(triggers, "I need your API key.\n::BLOCKED::")?.name).toBe("human_escalation");
    expect(matchTrigger(triggers, "Everything shipped.\n**::COMPLETE::**")?.name).toBe("all_complete");
  });
  it("ignores the keyword anywhere else", () => {
    expect(matchTrigger(triggers, "I'll print ::DONE:: when finished.\nStill working on tests.")).toBeNull();
    expect(matchTrigger(triggers, "")).toBeNull();
    expect(lastLine("a\n  b  \n\n")).toBe("b");
  });
  it("[/clear, /next] makes the 8 checked steps", () => {
    expect(cycleSteps(["/clear", "/next"], null).map((s) => s.name)).toEqual([
      "done_detected",
      "countdown",
      "clear_sent",
      "clear_confirmed",
      "idle",
      "next_sent",
      "turn_confirmed",
      "done",
    ]);
    expect(cycleSteps(["/clear", "/next"], "opus").map((s) => s.name)).toContain("model_restore");
  });
});

describe("A. /clear → /next cycle, every step confirmed", () => {
  it("runs all 8 steps, counts the cycle, and reads the phase from /next's reply", async () => {
    const c = stub();
    c.finishTurn("Implemented the login form.\nAll 42 tests pass.\n::DONE::");
    await advance(100);
    expect(c.state.cycles.current?.label).toBe("countdown");
    expect(c.state.countdown?.commands).toEqual(["/clear", "/next"]);
    expect(c.typed).toEqual([]); // nothing typed during the countdown

    await advance(sec(5) + 200); // countdown + hook latency + Enter
    expect(c.typed).toEqual(["/clear"]);
    await advance(sec(5));
    expect(c.typed).toEqual(["/clear", "/next"]);
    await advance(sec(3)); // /next's reply (Stop hook) arrives

    expect(c.stepsOk()).toEqual([
      "1/8 done_detected",
      "2/8 countdown",
      "3/8 clear_sent",
      "4/8 clear_confirmed",
      "5/8 idle",
      "6/8 next_sent",
      "7/8 turn_confirmed",
      "8/8 done",
    ]);
    expect(c.state.cycles.used).toBe(1);
    expect(c.state.cycles.current).toBeNull();
    const rec = c.state.cycles.recent[0];
    expect(rec).toMatchObject({ result: "ok", step: null, phase: "3: Auth refactor", trigger: "task_complete" });
    expect(rec.durationMs).toBeGreaterThan(sec(5));
    expect(c.state.cycles.lastOkAt).toBe(rec.endedAt);
    expect(c.checkpoints).toBe(1);
    expect(c.events("cycle.completed")).toHaveLength(1);
    expect(c.state.autopilot.enabled).toBe(true);
  });

  it("a /clear that is never confirmed fails the cycle at step 4, pauses, notifies, and never retries", async () => {
    const c = stub({ clear: "ignore" });
    c.finishTurn("Done.\n::DONE::");
    await advance(sec(5) + 500);
    expect(c.state.cycles.current).toMatchObject({ step: 4, total: 8, name: "clear_confirmed", label: "waiting for clear confirmation" });

    await advance(sec(30));
    expect(c.state.cycles.recent[0]).toMatchObject({ result: "failed", step: "clear_confirmed" });
    expect(c.state.cycles.failed).toBe(1);
    expect(c.state.cycles.used).toBe(0);
    expect(c.state.autopilot).toEqual({ enabled: false, pausedReason: "cycle_failed" });
    expect(c.notifications.at(-1)?.title).toBe("csuper: cycle failed");
    expect(c.notifications.at(-1)?.message).toContain("4/8 (clear_confirmed)");
    expect(c.events("cycle.failed")[0].data).toMatchObject({ step: "clear_confirmed", n: 4 });

    // No loop: nothing else is typed, and another DONE doesn't start a cycle while paused.
    await advance(min(10));
    c.finishTurn("::DONE::");
    await advance(min(10));
    expect(c.typed).toEqual(["/clear"]);
    expect(c.state.cycles.recent).toHaveLength(1);
    expect(c.events("cycle.skipped").at(-1)?.msg).toContain("autopilot cycle_failed");
  });

  it("a /next that never starts a turn fails at step 7", async () => {
    const c = stub({ next: "ignore" });
    c.finishTurn("::DONE::");
    await advance(sec(12));
    expect(c.state.cycles.current?.name).toBe("turn_confirmed");
    await advance(sec(31));
    expect(c.state.cycles.recent[0]).toMatchObject({ result: "failed", step: "turn_confirmed" });
    expect(c.state.autopilot.pausedReason).toBe("cycle_failed");
  });

  it("cancelling during the countdown sends nothing and records a cancelled cycle", async () => {
    const c = stub();
    c.finishTurn("::DONE::");
    await advance(sec(2));
    expect(c.engine.cancelCountdown()).toEqual({ ok: true });
    await advance(sec(30));
    expect(c.typed).toEqual([]);
    expect(c.state.countdown).toBeNull();
    expect(c.state.cycles.recent[0]).toMatchObject({ result: "cancelled", step: "countdown", reason: "cancelled by user" });
    expect(c.state.autopilot.enabled).toBe(true);
    expect(c.engine.cancelCountdown()).toEqual({ ok: false, error: "no countdown pending" });
  });

  it("the cycle breaker pauses at max_auto_cycles_per_session", async () => {
    const c = stub({ config: (cfg) => (cfg.rate_limits.circuit_breakers.max_auto_cycles_per_session = 2), nextReply: "Phase 1\n::DONE::" });
    c.finishTurn("::DONE::");
    await advance(min(1));
    expect(c.state.cycles.used).toBe(2); // each /next reply ends in ::DONE:: again
    expect(c.state.autopilot).toEqual({ enabled: false, pausedReason: "breaker" });
    expect(c.events("breaker.tripped")).toHaveLength(1);
    expect(c.typed.filter((t) => t === "/clear")).toHaveLength(2);
  });

  it("::BLOCKED:: and ::COMPLETE:: pause and notify without typing anything", async () => {
    const c = stub();
    c.finishTurn("I need the staging DB password.\n::BLOCKED::");
    await advance(100);
    expect(c.state.autopilot).toEqual({ enabled: false, pausedReason: "blocked" });
    expect(c.notifications[0]).toEqual({ title: "csuper: ::BLOCKED::", message: "I need the staging DB password." });
    const d = stub();
    d.finishTurn("All phases shipped.\n::COMPLETE::");
    await advance(100);
    expect(d.state.autopilot.pausedReason).toBe("complete");
    expect(c.typed).toEqual([]);
    expect(d.typed).toEqual([]);
  });

  it("pausing autopilot mid-cycle cancels it", async () => {
    const c = stub({ clear: "ignore" });
    c.finishTurn("::DONE::");
    await advance(sec(6));
    c.state.autopilot = { enabled: false, pausedReason: "user" };
    c.engine.onAutopilotChanged(false);
    await advance(sec(60));
    expect(c.state.cycles.recent[0]).toMatchObject({ result: "cancelled", reason: "autopilot paused" });
    expect(c.state.autopilot.pausedReason).toBe("user");
  });
});

describe("C. reset-time parsing (local timezone)", () => {
  const now = new Date(T0);
  it("same-day time of day", () => expect(parseResetTime("3:45pm", now)?.toISOString()).toBe("2026-11-14T15:45:00.000Z"));
  it("hour only, and the zone in parentheses", () => {
    expect(parseResetTime("3pm (UTC)", now)?.toISOString()).toBe("2026-11-14T15:00:00.000Z");
    // 3:45pm in Kolkata is 10:15 UTC, already past at noon UTC → tomorrow
    expect(parseResetTime("3:45pm (Asia/Kolkata)", now)?.toISOString()).toBe("2026-11-15T10:15:00.000Z");
  });
  it("a time already past rolls forward 24 h", () => {
    expect(parseResetTime("11:30am", now)?.toISOString()).toBe("2026-11-15T11:30:00.000Z");
    expect(parseResetTime("12:10am", now)?.toISOString()).toBe("2026-11-15T00:10:00.000Z");
  });
  it("dated resets, both formats", () => {
    expect(parseResetTime("Nov 15, 2am", now)?.toISOString()).toBe("2026-11-15T02:00:00.000Z");
    expect(parseResetTime("Nov 15 at 2:00am", now)?.toISOString()).toBe("2026-11-15T02:00:00.000Z");
    expect(parseResetTime("Jan 2, 2027, 3pm", now)?.toISOString()).toBe("2027-01-02T15:00:00.000Z");
    expect(parseResetTime("Jan 2, 3pm", now)?.toISOString()).toBe("2027-01-02T15:00:00.000Z"); // no year, already past → next year
  });
  it("garbage is null", () => {
    expect(parseResetTime("soon", now)).toBeNull();
    expect(parseResetTime("13pm", now)).toBeNull();
    expect(parseLimitMessage("You've hit your 5-hour limit · resets soon", now)?.resetAt).toBeNull();
  });
  it("kinds", () => {
    expect(parseLimitMessage("You've hit your 5-hour limit · resets 3pm", now)?.kind).toBe("session");
    expect(parseLimitMessage("You’ve hit your weekly limit · resets Nov 18, 9am", now)?.kind).toBe("weekly");
    expect(parseLimitMessage("You've hit your Opus limit · resets 6pm", now)).toMatchObject({ kind: "model", model: "opus" });
    expect(parseLimitMessage("Claude usage limit reached. Your limit will reset at 5pm", now)?.resetAt?.toISOString()).toBe("2026-11-14T17:00:00.000Z");
    expect(parseLimitMessage("Request rejected (429) · this may be a temporary capacity issue", now)).toBeNull();
  });
});

describe("C. automatic resume after usage limits", () => {
  it("same-day reset: waits with caffeinate, resumes at reset + margin, verifies, and records the wait", async () => {
    const c = stub();
    c.hitLimit("You've hit your 5-hour limit · resets 3:45pm (UTC)");
    await advance(100);
    const rl = c.state.rateLimit;
    expect(rl).toMatchObject({ status: "waiting", reason: "5-hour limit", source: "hook", resetAt: "2026-11-14T15:45:00.000Z", sessionResetAt: "2026-11-14T15:45:00.000Z" });
    expect(rl.resumeAt).toBe("2026-11-14T15:46:30.000Z"); // + reset_margin_seconds 90
    expect(c.caffeinate).toMatchObject({ running: true, starts: 1 });
    expect(rl.caffeinatePid).toBe(4321);
    // The PTY saw the same banner: hook first, so only one detection.
    await advance(sec(10));
    expect(c.events("ratelimit.detected")).toHaveLength(1);

    await advance(Date.parse("2026-11-14T15:46:29.000Z") - Date.now());
    expect(c.typed).toEqual([]);
    await advance(sec(2));
    expect(c.typed).toEqual(["continue"]);
    expect(c.state.rateLimit.status).toBe("resuming");
    await advance(sec(3)); // the resumed turn finishes (Stop) → proven
    expect(c.state.rateLimit).toMatchObject({ status: "ok", resumeAt: null, resumeAttempts: 0, failedResumes: 0, caffeinatePid: null });
    expect(c.state.rateLimit.totalWaitMs).toBeGreaterThanOrEqual(3 * 3600e3 + 46 * 60e3);
    expect(c.caffeinate).toMatchObject({ running: false, stops: 1 });
    expect(c.events("ratelimit.resumed")).toHaveLength(1);
  });

  it("no Stop within the window: a new turn plus 60 s without a limit message is success", async () => {
    const c = stub({ turnMs: min(5) });
    c.hitLimit("You've hit your 5-hour limit · resets 12:30pm");
    await advance(Date.parse("2026-11-14T12:31:31.000Z") - Date.now()); // reset + 90 s
    expect(c.typed).toEqual(["continue"]);
    await advance(sec(58));
    expect(c.state.rateLimit.status).toBe("resuming");
    await advance(sec(3));
    expect(c.state.rateLimit.status).toBe("ok");
  });

  it("after-midnight reset", async () => {
    vi.setSystemTime(new Date("2026-11-14T23:30:00.000Z"));
    const c = stub();
    c.hitLimit("You've hit your 5-hour limit · resets 12:10am");
    await advance(100);
    expect(c.state.rateLimit.resetAt).toBe("2026-11-15T00:10:00.000Z");
    expect(c.state.rateLimit.resumeAt).toBe("2026-11-15T00:11:30.000Z");
    await advance(min(42));
    expect(c.typed).toEqual(["continue"]);
  });

  it("dated (weekly) reset", async () => {
    const c = stub();
    c.hitLimit("You've hit your weekly limit · resets Nov 16, 2am (UTC)");
    await advance(100);
    expect(c.state.rateLimit).toMatchObject({ status: "waiting", reason: "weekly limit", weeklyResetAt: "2026-11-16T02:00:00.000Z", resumeAt: "2026-11-16T02:01:30.000Z" });
    await advance(Date.parse("2026-11-16T02:01:31.000Z") - Date.now());
    expect(c.typed).toEqual(["continue"]);
  });

  it("weekly quota at the stop % pauses and notifies instead of resuming", async () => {
    const c = stub();
    c.state.rateLimit.weeklyPct = 90; // once there is a real source
    c.hitLimit("You've hit your weekly limit · resets Nov 16, 2am");
    await advance(min(10));
    expect(c.state.autopilot.pausedReason).toBe("ratelimit");
    expect(c.state.rateLimit.resumeAt).toBeNull();
    expect(c.notifications.at(-1)?.title).toBe("csuper: weekly quota");
    await advance(3 * 86400e3);
    expect(c.typed).toEqual([]);
  });

  it("unparseable reset: 5 min, then doubling to 30 min, and it never stops for good", async () => {
    const still = { kind: "limited" as const, banner: "You've hit your 5-hour limit · resets soon" };
    const c = stub({ resume: [still, still, still, still, still, still, { kind: "ok" }] });
    c.hitLimit("You've hit your 5-hour limit · resets soon");
    await advance(100);
    expect(c.state.rateLimit).toMatchObject({ status: "waiting", resetAt: null });
    const gaps: number[] = [];
    let last = Date.now();
    for (let i = 0; i < 7; i++) {
      const before = c.typed.length;
      while (c.typed.length === before) await advance(sec(10));
      gaps.push(Math.round((Date.now() - last) / 60_000));
      last = Date.now();
    }
    expect(gaps).toEqual([5, 10, 20, 30, 30, 30, 30]);
    await advance(sec(5));
    expect(c.state.rateLimit.status).toBe("ok");
    expect(c.state.autopilot.enabled).toBe(true);
    expect(c.events("ratelimit.unparsed").length).toBeGreaterThanOrEqual(7);
  });

  it("still limited after resume: parses the new time and reschedules; 3 in a row pause + notify", async () => {
    const c = stub({
      resume: [
        { kind: "limited", banner: "You've hit your 5-hour limit · resets 2pm" },
        { kind: "limited", banner: "You've hit your 5-hour limit · resets 4pm" },
        { kind: "limited", banner: "You've hit your 5-hour limit · resets 6pm" },
      ],
    });
    c.hitLimit("You've hit your 5-hour limit · resets 1pm");
    await advance(min(62));
    expect(c.typed).toEqual(["continue"]);
    await advance(sec(2));
    expect(c.state.rateLimit).toMatchObject({ status: "waiting", failedResumes: 1, resetAt: "2026-11-14T14:00:00.000Z", resumeAt: "2026-11-14T14:01:30.000Z" });
    await advance(Date.parse("2026-11-14T14:01:31.000Z") - Date.now() + sec(2));
    expect(c.state.rateLimit).toMatchObject({ failedResumes: 2, resetAt: "2026-11-14T16:00:00.000Z" });
    await advance(Date.parse("2026-11-14T16:01:31.000Z") - Date.now() + sec(2));
    expect(c.typed).toEqual(["continue", "continue", "continue"]);
    expect(c.state.rateLimit.failedResumes).toBe(3);
    expect(c.state.autopilot).toEqual({ enabled: false, pausedReason: "ratelimit" });
    expect(c.notifications.at(-1)?.title).toBe("csuper: still rate-limited");
    await advance(min(600));
    expect(c.typed).toHaveLength(3); // no blind retries
  });

  it("a resume that never starts a turn pauses and notifies", async () => {
    const c = stub({ resume: [{ kind: "ignore" }] });
    c.hitLimit("You've hit your 5-hour limit · resets 12:30pm");
    await advance(min(32) + sec(31));
    expect(c.state.autopilot.pausedReason).toBe("ratelimit");
    expect(c.notifications.at(-1)?.title).toBe("csuper: resume failed");
  });

  it("reset reached while autopilot is paused: holds, then resumes when autopilot resumes", async () => {
    const c = stub();
    c.hitLimit("You've hit your 5-hour limit · resets 12:30pm");
    await advance(100);
    c.state.autopilot = { enabled: false, pausedReason: "user" };
    await advance(min(40));
    expect(c.typed).toEqual([]);
    expect(c.state.rateLimit.holding).toBe(true);
    c.state.autopilot = { enabled: true, pausedReason: null };
    c.engine.onAutopilotChanged(true);
    expect(c.typed).toEqual([]); // Enter follows the text
    await advance(sec(4));
    expect(c.typed).toEqual(["continue"]);
    expect(c.state.rateLimit.status).toBe("ok");
  });

  it("skip-wait sends resume_prompt now", async () => {
    const c = stub();
    expect(c.engine.skipWait().ok).toBe(false);
    c.hitLimit("You've hit your 5-hour limit · resets 3pm");
    await advance(100);
    expect(c.engine.skipWait()).toEqual({ ok: true });
    await advance(sec(3));
    expect(c.typed).toEqual(["continue"]);
  });

  it("triggers are paused while waiting", async () => {
    const c = stub();
    c.hitLimit("You've hit your 5-hour limit · resets 3pm");
    await advance(100);
    c.finishTurn("::DONE::");
    await advance(min(1));
    expect(c.typed).toEqual([]);
    expect(c.events("cycle.skipped")[0].msg).toContain("rate limit");
  });

  it("a limit during the countdown cancels the cycle before /clear", async () => {
    const c = stub();
    c.finishTurn("::DONE::");
    await advance(sec(1));
    c.hitLimit("You've hit your 5-hour limit · resets 3pm");
    await advance(sec(30));
    expect(c.typed).toEqual([]);
    expect(c.state.cycles.recent[0]).toMatchObject({ result: "cancelled", reason: "rate limit" });
  });

  it("every raw limit message is saved as a sample", async () => {
    const c = stub();
    c.hitLimit("You've hit your 5-hour limit · resets 3pm");
    await advance(sec(10));
    expect(c.samples.map((s) => s.source).sort()).toEqual(["hook", "pty"]);
    const hook = c.samples.find((s) => s.source === "hook")!;
    expect(hook).toMatchObject({ text: "You've hit your 5-hour limit · resets 3pm", error: "rate_limit", disposition: "new" });
    expect((hook.parsed as any).resetAt).toBe("2026-11-14T15:00:00.000Z");
  });

  it("no hook (screen only): the banner is acted on after the grace period", async () => {
    const c = stub({ hooks: false });
    c.print(BANNER("You've hit your 5-hour limit · resets 3pm"));
    await advance(sec(4));
    expect(c.state.rateLimit.status).toBe("ok");
    await advance(sec(2));
    expect(c.state.rateLimit).toMatchObject({ status: "waiting", source: "pty", resetAt: "2026-11-14T15:00:00.000Z" });
  });

  it("a banner that is just part of the conversation is ignored (the turn ended normally)", async () => {
    const c = stub();
    c.print("Here is the message: You've hit your 5-hour limit · resets 3pm\r\n");
    c.finishTurn("I explained the rate-limit banner.");
    await advance(sec(10));
    expect(c.state.rateLimit.status).toBe("ok");
  });
});

describe("C. model-specific cap: Opus → Sonnet, and back at a cycle boundary", () => {
  it("switches to sonnet, continues right away, and switches back after the Opus reset, between /clear and /next", async () => {
    const c = stub({ nextReply: "Starting Phase 4: Billing" });
    c.hitLimit("You've hit your Opus limit · resets 6pm (UTC)");
    await advance(sec(1));
    expect(c.typed).toEqual(["/model sonnet", "continue"]);
    expect(c.state.model).toBe("claude-sonnet-5-5");
    await advance(sec(3));
    expect(c.state.rateLimit.status).toBe("failover");
    expect(c.state.rateLimit.failovers).toEqual([{ ts: expect.any(String), from: "opus", to: "sonnet", reason: "Opus limit", restoredAt: null }]);
    expect(c.state.rateLimit.modelRestoreAt).toBe("2026-11-14T18:01:30.000Z");
    expect(c.events("model.failover")[0].msg).toContain("opus → sonnet");

    // A cycle before the Opus reset stays on sonnet.
    c.finishTurn("::DONE::");
    await advance(sec(20));
    expect(c.typed.slice(2)).toEqual(["/clear", "/next"]);
    expect(c.stepsOk(1)).not.toContain("6/9 model_restore");

    // After the reset: the next cycle switches back after /clear, before /next (never mid-turn).
    await advance(Date.parse("2026-11-14T18:05:00.000Z") - Date.now());
    c.finishTurn("::DONE::");
    await advance(sec(20));
    expect(c.typed.slice(4)).toEqual(["/clear", "/model opus", "/next"]);
    expect(c.stepsOk(2)).toEqual([
      "1/9 done_detected",
      "2/9 countdown",
      "3/9 clear_sent",
      "4/9 clear_confirmed",
      "5/9 idle",
      "6/9 model_restore",
      "7/9 next_sent",
      "8/9 turn_confirmed",
      "9/9 done",
    ]);
    expect(c.state.model).toBe("claude-opus-5-5");
    expect(c.state.rateLimit.status).toBe("ok");
    expect(c.state.rateLimit.failovers![0].restoredAt).not.toBeNull();
    expect(c.state.rateLimit.modelRestoreAt).toBeNull();
  });

  it("a /model switch that isn't confirmed pauses and notifies", async () => {
    const c = stub();
    (c as any).onLine = () => {}; // claude ignores everything
    c.hitLimit("You've hit your Opus limit · resets 6pm");
    await advance(sec(31));
    expect(c.state.autopilot.pausedReason).toBe("ratelimit");
    expect(c.notifications.at(-1)?.title).toBe("csuper: model failover failed");
  });

  it("an Opus limit while already on sonnet just waits", async () => {
    const c = stub({ model: "claude-sonnet-5-5" });
    c.hitLimit("You've hit your Opus limit · resets 6pm");
    await advance(sec(1));
    expect(c.typed).toEqual([]);
    expect(c.state.rateLimit).toMatchObject({ status: "waiting", modelResetAt: "2026-11-14T18:00:00.000Z" });
  });
});
