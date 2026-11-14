/**
 * Autopilot engine: keyword triggers, the checked /clear → /next cycle, and automatic
 * resume after usage limits (with model failover).
 *
 * Nothing here is fire-and-forget. Every command csuper types into claude is followed
 * by a confirmation from a Claude Code hook (or, for "idle", from the terminal going
 * quiet) within `autopilot.cycle_step_timeout_ms`. A missing confirmation fails the
 * cycle, pauses autopilot ("cycle_failed"), notifies, and logs. Nothing is retried blindly.
 *
 * Signals used (Claude Code 2.1.325, hooks registered by the supervisor via --settings):
 *   Stop                 last_assistant_message → keyword triggers; phase /next started
 *   SessionStart         source "clear" → /clear confirmed; model → active model
 *   UserPromptSubmit     prompt → a typed command started a turn
 *   UserPromptExpansion  command_name → a slash command (/next) expanded into a turn
 *   StopFailure          error "rate_limit" + last_assistant_message → usage limit
 *   Notification         message → usage limit (if it contains one)
 *   PostModelSwitch      to_model → /model switch confirmed
 * Plus the PTY: limit banners (fallback when no hook reports one) and output quietness.
 *
 * The engine is I/O-free: everything goes through `Host`, so tests drive it with a stub
 * claude and fake timers.
 */
import type { Config, TriggerConfig } from "../config.js";
import type { CycleRecord, DashState, DeepPartial, Failover, PausedReason } from "../state.js";
import { findLimitMessage, insideActiveHours, modelFamily, parseLimitMessage, PtyLimitScanner, readPhase, type LimitInfo } from "./limits.js";

/** What the hook script sends (hooks/csuper-hook.js). */
export interface HookMsg {
  type: "hook";
  event: string;
  tool?: string | null;
  ok?: boolean;
  source?: string | null;
  model?: string | null;
  prompt?: string | null;
  command_name?: string | null;
  last_assistant_message?: string | null;
  stop_error?: string | null;
  error_details?: string | null;
  notification_type?: string | null;
  message?: string | null;
  to_model?: string | null;
  from_model?: string | null;
}

export interface LogSink {
  debug(event: string, msg: string, data?: Record<string, unknown>): unknown;
  info(event: string, msg: string, data?: Record<string, unknown>): unknown;
  warn(event: string, msg: string, data?: Record<string, unknown>): unknown;
  error(event: string, msg: string, data?: Record<string, unknown>): unknown;
}

export interface Host {
  /** Raw bytes to claude's PTY. */
  write(data: string): void;
  getState(): DashState;
  patch(p: DeepPartial<DashState>): void;
  log: LogSink;
  notify(title: string, message: string): void;
  /** Start `caffeinate -i`; returns its pid (null if it couldn't start). */
  startCaffeinate(): number | null;
  stopCaffeinate(): void;
  gitCheckpoint(trigger: string): Promise<{ sha: string; files: number } | null>;
  /** Save claude's final message; returns the file written. */
  saveHandover(text: string, trigger: string): string | null;
  /** Append one raw limit message to ~/.csuper/logs/ratelimit-samples.jsonl. */
  saveSample(rec: Record<string, unknown>): void;
  /** Time of claude's last terminal output (ms). */
  lastOutputAt(): number;
}

export class StepTimeout extends Error {
  constructor(readonly step: string) {
    super(`no confirmation for ${step}`);
  }
}
export class Cancelled extends Error {}

type Owner = "cycle" | "rl";
interface Waiter {
  owner: Owner;
  match?: (m: HookMsg) => boolean;
  poll?: () => boolean;
  resolve: (m: HookMsg | null) => void;
  reject: (e: Error) => void;
  timers: NodeJS.Timeout[];
}

interface StepDef {
  name: string;
  label: string;
}

const iso = (ms = Date.now()) => new Date(ms).toISOString();
const clip = (s: string | null | undefined, n: number) => (s ? (s.length > n ? s.slice(0, n) + "…" : s) : null);
/** Gap between typing a command and pressing Enter, so the input box doesn't treat both as one paste. */
export const ENTER_DELAY_MS = 150;

/** Last non-empty line, without surrounding markdown emphasis/backticks. */
export function lastLine(text: string | null | undefined): string {
  const lines = (text ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return (lines.at(-1) ?? "").replace(/^[`*_>\s]+|[`*_\s]+$/g, "");
}

/** `last_line` match: the last line is the keyword, or ends with it. */
export function matchTrigger(triggers: TriggerConfig[], text: string | null | undefined): TriggerConfig | null {
  const line = lastLine(text);
  if (!line) return null;
  return triggers.find((t) => t.enabled && (line === t.keyword || line.endsWith(t.keyword))) ?? null;
}

/** The checked steps for a trigger's commands. [/clear, /next] → the 8 steps. */
export function cycleSteps(commands: string[], restoreModel: string | null): StepDef[] {
  const steps: StepDef[] = [
    { name: "done_detected", label: "DONE detected" },
    { name: "countdown", label: "countdown" },
  ];
  let restored = !restoreModel;
  for (const cmd of commands) {
    const word = cmd.trim().split(/\s+/)[0];
    const base = word.replace(/^\//, "").replace(/[^a-z0-9_]/gi, "_") || "command";
    if (word === "/clear" || word === "/compact") {
      steps.push(
        { name: `${base}_sent`, label: `sending ${cmd}` },
        { name: `${base}_confirmed`, label: `waiting for ${base} confirmation` },
        { name: "idle", label: "waiting for claude idle" },
      );
      continue;
    }
    if (!restored) {
      steps.push({ name: "model_restore", label: `switching back to ${restoreModel}` });
      restored = true;
    }
    steps.push({ name: `${base}_sent`, label: `sending ${cmd}` }, { name: "turn_confirmed", label: "waiting for new turn" });
  }
  steps.push({ name: "done", label: "cycle done" });
  return steps;
}

export class Autopilot {
  private waiters = new Set<Waiter>();
  private cycleSeq = 0;
  private cycleRunning = false;
  private cycleCancel: ((reason: string) => void) | null = null;
  private inCountdown = false;
  private awaitingPhase: number | null = null;
  private scanner = new PtyLimitScanner();
  private screen = ""; // recent cleaned output, for "Set model to …"
  private hooksSeen = false;
  private lastActivityAt = 0;
  private lastHookLimitAt = 0;
  private lastStopAt = 0;
  // Rate limits
  private resumeTimer: NodeJS.Timeout | null = null;
  private turnTimer: NodeJS.Timeout | null = null;
  private verifyTimer: NodeJS.Timeout | null = null;
  private phase: "idle" | "await_turn" | "verify" = "idle";
  private backoffMs = 0;
  private limitAtMs = 0;
  private failoverBusy = false;
  private disposed = false;

  constructor(
    private readonly host: Host,
    private config: Config,
  ) {
    this.backoffMs = config.rate_limits.unparsed_retry_initial_seconds * 1000;
  }

  setConfig(c: Config): void {
    this.config = c;
  }

  private get st(): DashState {
    return this.host.getState();
  }
  private get rl() {
    return this.config.rate_limits;
  }
  private get stepTimeout() {
    return this.config.autopilot.cycle_step_timeout_ms;
  }

  // ------------------------------------------------------------------ inputs

  onHook(m: HookMsg): void {
    if (this.disposed || !m || m.type !== "hook") return;
    this.hooksSeen = true;
    const now = Date.now();
    if (m.event === "SessionStart" && m.model) this.setModel(m.model, "session start");
    if (m.event === "PostModelSwitch" && m.to_model) this.setModel(m.to_model, "model switch");
    if (["UserPromptSubmit", "UserPromptExpansion", "PostToolUse", "PostToolUseFailure", "Stop"].includes(m.event)) this.lastActivityAt = now;

    // Resolve whatever a cycle or failover is waiting for.
    for (const w of [...this.waiters]) if (w.match?.(m)) this.settle(w, () => w.resolve(m));

    switch (m.event) {
      case "UserPromptSubmit":
        if (this.phase === "await_turn") this.resumeTurnStarted();
        break;
      case "StopFailure":
        if (m.stop_error === "rate_limit" || findLimitMessage(m.last_assistant_message)) {
          this.onLimit("hook", m.last_assistant_message || m.error_details || "", { error: m.stop_error, error_details: clip(m.error_details, 2000) });
        } else {
          this.host.log.warn("ratelimit.detected", `turn ended with API error ${m.stop_error ?? "unknown"} (not a usage limit)`, { error: m.stop_error });
        }
        break;
      case "Notification":
        if (findLimitMessage(m.message)) this.onLimit("hook", m.message!, { notification_type: m.notification_type ?? null });
        break;
      case "Stop":
        this.lastStopAt = now;
        this.onStop(m);
        break;
    }
  }

  onPtyData(chunk: string): void {
    if (this.disposed) return;
    const clean = PtyLimitScanner.clean(chunk);
    this.screen = (this.screen + clean).slice(-2000);
    for (const line of this.scanner.push(chunk)) {
      const seenAt = Date.now();
      this.host.saveSample({ source: "pty", text: line, parsed: summarize(parseLimitMessage(line)), disposition: "seen" });
      // Hook first: act on the screen only if no hook reports a limit (and the turn didn't
      // simply end, which would mean the text was just part of the conversation).
      setTimeout(() => {
        if (this.disposed) return;
        if (this.lastHookLimitAt >= seenAt - 15_000) return this.host.log.debug("ratelimit.ignored", "banner on screen already reported by a hook");
        if (this.lastStopAt > seenAt) return this.host.log.debug("ratelimit.ignored", "banner on screen ignored: the turn ended normally");
        if (this.hooksSeen && this.st.rateLimit.status !== "ok" && this.st.rateLimit.status !== "failover") return;
        this.onLimit("pty", line, {});
      }, this.rl.pty_fallback_grace_ms).unref?.();
    }
  }

  /** Called after the supervisor changed autopilot (Ctrl+G, ctl, dash). */
  onAutopilotChanged(enabled: boolean): void {
    if (!enabled) {
      if (this.cycleRunning) this.cycleCancel?.("autopilot paused");
      return;
    }
    if (this.st.rateLimit.holding) {
      this.host.log.info("ratelimit.resumed", "autopilot resumed while the reset time had passed: resuming now");
      this.resume("autopilot resumed");
    }
  }

  cancelCountdown(): { ok: boolean; error?: string } {
    if (!this.cycleRunning || !this.inCountdown) return { ok: false, error: "no countdown pending" };
    this.cycleCancel?.("cancelled by user");
    return { ok: true };
  }

  skipWait(): { ok: boolean; error?: string } {
    const s = this.st.rateLimit.status;
    if (s !== "waiting") return { ok: false, error: "not waiting on a rate limit" };
    this.host.log.warn("ratelimit.resumed", "skip-wait: sending resume_prompt now");
    this.resume("skip-wait", true);
    return { ok: true };
  }

  dispose(): void {
    this.disposed = true;
    for (const t of [this.resumeTimer, this.turnTimer, this.verifyTimer]) if (t) clearTimeout(t);
    for (const w of [...this.waiters]) this.settle(w, () => w.reject(new Cancelled("supervisor exiting")));
    this.host.stopCaffeinate();
  }

  // ------------------------------------------------------------------ helpers

  private type(text: string): void {
    this.host.write(text);
    setTimeout(() => {
      if (!this.disposed) this.host.write("\r");
    }, ENTER_DELAY_MS);
    this.host.log.info("command.injected", `sent ${text}`, { command: text });
  }

  private settle(w: Waiter, fn: () => void): void {
    if (!this.waiters.delete(w)) return;
    for (const t of w.timers) clearTimeout(t);
    fn();
  }

  /** Wait for a hook matching `match` (or `poll()` to turn true). Rejects with StepTimeout. */
  private wait(owner: Owner, step: string, opts: { match?: (m: HookMsg) => boolean; poll?: () => boolean; timeoutMs: number; sleep?: boolean }): Promise<HookMsg | null> {
    return new Promise((resolve, reject) => {
      const w: Waiter = { owner, match: opts.match, poll: opts.poll, resolve, reject, timers: [] };
      this.waiters.add(w);
      w.timers.push(setTimeout(() => this.settle(w, () => (opts.sleep ? resolve(null) : reject(new StepTimeout(step)))), opts.timeoutMs));
      if (opts.poll) {
        const tick = () => {
          if (!this.waiters.has(w)) return;
          if (opts.poll!()) return this.settle(w, () => resolve(null));
          w.timers.push(setTimeout(tick, 100));
        };
        tick();
      }
    });
  }

  private cancelOwner(owner: Owner, reason: string): void {
    for (const w of [...this.waiters]) if (w.owner === owner) this.settle(w, () => w.reject(new Cancelled(reason)));
  }

  private pause(reason: Exclude<PausedReason, null>, why: string): void {
    this.host.patch({ autopilot: { enabled: false, pausedReason: reason } });
    this.host.log.warn("autopilot.toggled", `autopilot paused: ${why}`, { enabled: false, reason });
    if (this.cycleRunning && reason !== "cycle_failed") this.cycleCancel?.(why);
  }

  private notify(title: string, message: string): void {
    this.host.notify(title, message);
    this.host.log.info("notify.sent", `${title}: ${message}`, { title, message });
  }

  private setModel(model: string, why: string): void {
    if (this.st.model === model) return;
    this.host.patch({ model });
    this.host.log.info("model.changed", `model is now ${model} (${why})`, { model });
  }

  // ------------------------------------------------------------------ triggers

  private onStop(m: HookMsg): void {
    const text = m.last_assistant_message ?? "";
    // A finished turn during resume verification proves the resume worked.
    if (this.st.rateLimit.status === "resuming" && this.phase !== "idle") this.resumeSucceeded("the resumed turn finished");

    if (this.awaitingPhase !== null) {
      const phase = readPhase(text);
      const id = this.awaitingPhase;
      this.awaitingPhase = null;
      if (phase) {
        const recent = this.st.cycles.recent.map((r) => (r.id === id ? { ...r, phase } : r));
        this.host.patch({ cycles: { recent } });
        this.host.log.info("cycle.phase", `cycle #${id}: /next started phase ${phase}`, { cycle: id, phase });
      }
    }

    const t = matchTrigger(this.config.triggers, text);
    if (!t) return;
    const ts = iso();
    const recent = [...this.st.triggers.recent, { name: t.name, keyword: t.keyword, ts, commands: t.commands }].slice(-50);
    this.host.patch({ triggers: { recent } });
    this.host.log.info("trigger.matched", `${t.keyword} matched (last_line)`, { trigger: t.name, commands: t.commands });

    if (t.pause_autopilot) this.pause(t.name === "all_complete" ? "complete" : "blocked", `${t.keyword} (${t.name})`);
    if (t.notify_macos) this.notify(`csuper: ${t.keyword}`, clip(lastLines(text, t.keyword), 200) ?? t.name);
    if (t.commands.length) void this.startCycle(t, text);
  }

  // ------------------------------------------------------------------ cycles

  private async startCycle(t: TriggerConfig, text: string): Promise<void> {
    const s = this.st;
    const skip = (why: string): void => void this.host.log.warn("cycle.skipped", `${t.keyword}: cycle not started (${why})`, { trigger: t.name, why });
    if (this.cycleRunning) return skip("a cycle is already running");
    if (!s.autopilot.enabled) return skip(`autopilot ${s.autopilot.pausedReason ?? "off"}`);
    if (s.rateLimit.status === "waiting" || s.rateLimit.status === "resuming") return skip("waiting on a rate limit");
    const hours = this.config.rate_limits.circuit_breakers.active_hours;
    if (!insideActiveHours(hours)) {
      this.host.patch({ activeHours: { window: hours, inside: false } });
      this.pause("hours", `outside active_hours ${hours}`);
      return skip("outside active hours");
    }
    if (s.cycles.used >= s.cycles.max) {
      this.host.log.error("breaker.tripped", `max_auto_cycles_per_session reached (${s.cycles.used}/${s.cycles.max}); autopilot paused`, { used: s.cycles.used, max: s.cycles.max });
      this.pause("breaker", `cycle limit ${s.cycles.max} reached`);
      this.notify("csuper: cycle limit reached", `${s.cycles.used}/${s.cycles.max} cycles done; autopilot paused`);
      return skip("cycle limit reached");
    }
    await this.runCycle(t, text);
  }

  private restoreDue(): string | null {
    const r = this.st.rateLimit;
    const primary = this.rl.model_failover_order[0];
    if (!r.modelRestoreAt || !primary || Date.parse(r.modelRestoreAt) > Date.now()) return null;
    return modelFamily(this.st.model) === modelFamily(primary) ? null : primary;
  }

  private async runCycle(t: TriggerConfig, text: string): Promise<void> {
    this.cycleRunning = true;
    const id = ++this.cycleSeq;
    const restore = this.restoreDue();
    const steps = cycleSteps(t.commands, restore);
    const total = steps.length;
    const startedAt = Date.now();
    let stepIdx = 0;
    let stepStart = startedAt;
    let cancelReason: string | null = null;
    let restorePending = !!restore;
    this.cycleCancel = (reason) => {
      cancelReason = reason;
      this.cancelOwner("cycle", reason);
    };

    const begin = (name: string, timeout: number | null) => {
      stepIdx = steps.findIndex((s, i) => i >= stepIdx && s.name === name);
      const def = steps[stepIdx];
      stepStart = Date.now();
      this.host.patch({
        cycles: {
          current: {
            id,
            trigger: t.name,
            startedAt: iso(startedAt),
            step: stepIdx + 1,
            total,
            name: def.name,
            label: def.label,
            stepStartedAt: iso(stepStart),
            deadline: timeout === null ? null : iso(stepStart + timeout),
          },
        },
      });
      this.host.log.debug("cycle.step", `cycle #${id} ${stepIdx + 1}/${total} ${def.label}…`, { cycle: id, step: def.name, n: stepIdx + 1, total, status: "started" });
    };
    const ok = (extra: Record<string, unknown> = {}) => {
      const def = steps[stepIdx];
      this.host.log.info("cycle.step", `cycle #${id} ${stepIdx + 1}/${total} ${def.name} ok (${Date.now() - stepStart} ms)`, {
        cycle: id,
        step: def.name,
        n: stepIdx + 1,
        total,
        status: "ok",
        ms: Date.now() - stepStart,
        ...extra,
      });
    };
    const guard = () => {
      if (cancelReason) throw new Cancelled(cancelReason);
      const s = this.st;
      if (!s.autopilot.enabled) throw new Cancelled(`autopilot ${s.autopilot.pausedReason ?? "paused"}`);
      if (s.rateLimit.status === "waiting" || s.rateLimit.status === "resuming") throw new Cancelled("rate limit");
    };
    const finish = (rec: Omit<CycleRecord, "id" | "trigger" | "startedAt" | "endedAt" | "durationMs">) => {
      const s = this.st;
      const record: CycleRecord = { id, trigger: t.name, startedAt: iso(startedAt), endedAt: iso(), durationMs: Date.now() - startedAt, ...rec };
      const recent = [...s.cycles.recent, record].slice(-10);
      const patch: DeepPartial<DashState> = { countdown: null, cycles: { current: null, recent } };
      if (rec.result === "ok") patch.cycles = { ...patch.cycles, used: s.cycles.used + 1, lastOkAt: record.endedAt };
      if (rec.result === "failed") patch.cycles = { ...patch.cycles, failed: s.cycles.failed + 1 };
      this.host.patch(patch);
      return record;
    };

    this.host.log.info("cycle.started", `cycle #${id} started by ${t.keyword} (${t.commands.join(" → ")})`, { cycle: id, trigger: t.name, commands: t.commands, steps: steps.map((s) => s.name) });
    try {
      // 1. DONE detected (Stop hook). Handover + checkpoint belong to this step.
      begin("done_detected", null);
      const extra: Record<string, unknown> = {};
      if (t.save_handover) {
        const f = this.host.saveHandover(text, t.name);
        extra.handover = f;
        if (f) this.host.log.info("handover.saved", `saved claude's final message to ${f}`, { file: f });
      }
      if (t.git_checkpoint) {
        try {
          const cp = await this.host.gitCheckpoint(t.name);
          extra.checkpoint = cp?.sha ?? null;
          if (cp) this.host.patch({ git: { lastCheckpoint: { sha: cp.sha, ts: iso(), files: cp.files } } });
        } catch (e) {
          this.host.log.warn("git.checkpoint", `checkpoint failed: ${(e as Error).message}`);
        }
      }
      ok(extra);
      guard();

      // 2. Countdown (c cancels).
      const delay = this.config.pre_clear_delay_ms;
      begin("countdown", null);
      this.inCountdown = true;
      this.host.patch({ countdown: { trigger: t.name, firesAt: iso(Date.now() + delay), commands: t.commands } });
      this.host.log.info("countdown.started", `${t.commands.join(" ")} in ${delay} ms (c cancels)`, { cycle: id, trigger: t.name, ms: delay });
      await this.wait("cycle", "countdown", { timeoutMs: delay, sleep: true });
      this.inCountdown = false;
      this.host.patch({ countdown: null });
      guard();
      this.host.log.info("countdown.fired", `countdown finished`, { cycle: id });
      ok();

      for (const cmd of t.commands) {
        const word = cmd.trim().split(/\s+/)[0];
        const base = word.replace(/^\//, "").replace(/[^a-z0-9_]/gi, "_") || "command";
        if (word === "/clear" || word === "/compact") {
          // 3. /clear sent; 4. confirmed by SessionStart(source=clear); 5. idle.
          guard();
          begin(`${base}_sent`, null);
          const confirmed = this.wait("cycle", `${base}_confirmed`, { match: (m) => m.event === "SessionStart" && m.source === base, timeoutMs: this.stepTimeout });
          confirmed.catch(() => {}); // handled below
          this.type(cmd);
          ok();
          begin(`${base}_confirmed`, this.stepTimeout);
          await confirmed;
          ok({ source: base });
          begin("idle", this.stepTimeout);
          const quiet = this.config.autopilot.idle_quiet_ms;
          await this.wait("cycle", "idle", { poll: () => Date.now() - this.host.lastOutputAt() >= quiet, timeoutMs: this.stepTimeout });
          ok();
          continue;
        }
        if (restore && restorePending) {
          restorePending = false;
          guard();
          begin("model_restore", this.stepTimeout);
          await this.switchModel("cycle", restore, "model_restore");
          this.modelRestored(restore);
          ok({ model: restore });
        }
        // 6. /next sent; 7. confirmed by UserPromptSubmit / UserPromptExpansion.
        guard();
        begin(`${base}_sent`, null);
        const started = this.wait("cycle", "turn_confirmed", {
          match: (m) =>
            (m.event === "UserPromptSubmit" && (m.prompt ?? "").trim().startsWith(cmd.trim())) ||
            (m.event === "UserPromptExpansion" && (m.command_name ?? "").replace(/^\//, "") === base),
          timeoutMs: this.stepTimeout,
        });
        started.catch(() => {});
        this.type(cmd);
        ok();
        begin("turn_confirmed", this.stepTimeout);
        const ev = await started;
        ok({ via: ev?.event });
      }

      // 8. Cycle done.
      begin("done", null);
      ok();
      const rec = finish({ result: "ok", step: null, reason: null, phase: null });
      this.awaitingPhase = id;
      const s = this.st;
      this.host.log.info("cycle.completed", `cycle #${id} ok in ${Math.round(rec.durationMs / 1000)} s (${s.cycles.used}/${s.cycles.max})`, {
        cycle: id,
        ms: rec.durationMs,
        used: s.cycles.used,
        max: s.cycles.max,
      });
    } catch (e) {
      this.inCountdown = false;
      const step = steps[stepIdx]?.name ?? "unknown";
      if (e instanceof Cancelled) {
        finish({ result: "cancelled", step, reason: e.message, phase: null });
        this.host.log.warn("cycle.cancelled", `cycle #${id} cancelled at ${step}: ${e.message}`, { cycle: id, step, reason: e.message });
        if (step === "countdown") this.host.log.info("countdown.cancelled", `countdown cancelled (${e.message})`, { cycle: id, reason: e.message });
      } else {
        const why = e instanceof StepTimeout ? `no confirmation within ${Math.round(this.stepTimeout / 1000)} s` : (e as Error).message;
        finish({ result: "failed", step, reason: why, phase: null });
        this.host.log.error("cycle.failed", `cycle #${id} failed at ${stepIdx + 1}/${total} ${step}: ${why}`, { cycle: id, step, n: stepIdx + 1, total, reason: why });
        this.pause("cycle_failed", `cycle #${id} failed at ${step}`);
        this.notify("csuper: cycle failed", `cycle #${id} failed at step ${stepIdx + 1}/${total} (${step}): ${why}. Autopilot paused.`);
      }
    } finally {
      this.cycleRunning = false;
      this.cycleCancel = null;
      this.cancelOwner("cycle", "cycle ended");
    }
  }

  // ------------------------------------------------------------------ model failover

  /** Type `/model <to>` and wait for PostModelSwitch (or "Set model to" on screen). */
  private async switchModel(owner: Owner, to: string, step: string): Promise<void> {
    const fam = modelFamily(to);
    this.screen = ""; // only output after the command counts
    const confirmed = this.wait(owner, step, {
      match: (m) => m.event === "PostModelSwitch" && modelFamily(m.to_model) === fam,
      poll: () => new RegExp(`Set model to[^\\n]*${fam}`, "i").test(this.screen),
      timeoutMs: this.stepTimeout,
    });
    confirmed.catch(() => {});
    this.type(`/model ${to}`);
    await confirmed;
    if (modelFamily(this.st.model) !== fam) this.setModel(to, "/model");
  }

  private modelRestored(to: string): void {
    const r = this.st.rateLimit;
    const failovers: Failover[] = (r.failovers ?? []).map((f, i, a) => (i === a.length - 1 && !f.restoredAt ? { ...f, restoredAt: iso() } : f));
    this.host.patch({ rateLimit: { modelRestoreAt: null, modelResetAt: null, failovers, status: r.status === "failover" ? "ok" : r.status } });
    this.host.log.info("model.failover", `switched back to ${to} (its limit has reset)`, { to, restored: true });
  }

  private failoverTarget(info: LimitInfo): string | null {
    if (info.kind !== "model" || !info.model) return null;
    const order = this.rl.model_failover_order.map((m) => modelFamily(m));
    const cur = modelFamily(this.st.model);
    if (cur && order.includes(cur) && cur !== info.model) return null; // the capped model isn't the one in use
    const i = order.indexOf(info.model);
    if (i < 0) return null;
    return this.rl.model_failover_order[i + 1] ?? null;
  }

  private async failover(info: LimitInfo, to: string): Promise<void> {
    this.failoverBusy = true;
    const from = info.model ?? modelFamily(this.st.model) ?? "?";
    const resetAt = info.resetAt ? iso(info.resetAt.getTime()) : null;
    const restoreAt = info.resetAt ? iso(info.resetAt.getTime() + this.rl.reset_margin_seconds * 1000) : null;
    this.host.patch({
      rateLimit: { status: "failover", reason: info.label, message: clip(info.raw, 300), resetAt, modelResetAt: resetAt, resumeAt: null, detectedAt: iso() },
    });
    this.host.log.warn("model.failover", `${info.label} hit: switching ${from} → ${to}, then continuing`, { from, to, resetAt, restoreAt });
    try {
      await this.switchModel("rl", to, "model_failover");
    } catch (e) {
      this.failoverBusy = false;
      const why = e instanceof StepTimeout ? `/model ${to} not confirmed within ${Math.round(this.stepTimeout / 1000)} s` : (e as Error).message;
      this.host.log.error("model.failover", `failover to ${to} failed: ${why}`, { from, to, reason: why });
      this.host.patch({ rateLimit: { status: "waiting" } });
      this.pause("ratelimit", `model failover failed (${why})`);
      this.notify("csuper: model failover failed", `${info.label}: ${why}. Autopilot paused.`);
      return;
    }
    const failovers = [...(this.st.rateLimit.failovers ?? []), { ts: iso(), from, to, reason: info.label, restoredAt: null }].slice(-20);
    this.host.patch({ rateLimit: { failovers, modelRestoreAt: restoreAt } });
    this.failoverBusy = false;
    this.resume("model failover", true);
  }

  // ------------------------------------------------------------------ rate limits

  private onLimit(source: "hook" | "pty", text: string, extra: Record<string, unknown>): void {
    const now = Date.now();
    if (source === "hook") this.lastHookLimitAt = now;
    const info = parseLimitMessage(text, new Date(now)) ?? { kind: "unknown" as const, label: "usage limit", model: null, resetText: null, resetAt: null, raw: text.slice(0, 500) };
    const r = this.st.rateLimit;
    const sample = { source, text: clip(text, 4000), ...extra, parsed: summarize(info) };

    // Resume being verified and the limit is back → that resume failed.
    if (r.status === "resuming") {
      this.host.saveSample({ ...sample, disposition: "resume_failed" });
      return this.resumeFailed(info, source);
    }
    if (this.failoverBusy) {
      this.host.saveSample({ ...sample, disposition: "during_failover" });
      return;
    }
    if (r.status === "waiting") {
      // Already waiting: only take a better reading (a reset time where there was none).
      this.host.saveSample({ ...sample, disposition: "duplicate" });
      if (!r.resetAt && info.resetAt && !r.holding) {
        this.host.log.info("ratelimit.detected", `reset time now known: ${info.resetText}`, { resetAt: iso(info.resetAt.getTime()) });
        this.schedule(info, source, text);
      }
      return;
    }
    this.host.saveSample({ ...sample, disposition: "new" });
    this.limitAtMs = now;
    this.host.log.warn("ratelimit.detected", `${info.label} hit (${source})${info.resetText ? ` · resets ${info.resetText}` : " · reset time unreadable"}`, {
      source,
      kind: info.kind,
      label: info.label,
      model: info.model,
      resetText: info.resetText,
      resetAt: info.resetAt ? iso(info.resetAt.getTime()) : null,
      message: clip(info.raw, 300),
    });
    if (this.cycleRunning && this.inCountdown) this.cycleCancel?.("rate limit");

    const to = this.failoverTarget(info);
    if (to) {
      void this.failover(info, to);
      return;
    }
    this.schedule(info, source, text);
  }

  /** Enter (or update) a wait: resume at reset + margin, or after a backoff when unreadable. */
  private schedule(info: LimitInfo, source: "hook" | "pty", text: string): void {
    const now = Date.now();
    const r = this.st.rateLimit;
    const cb = this.rl.circuit_breakers;
    const resetAt = info.resetAt ? iso(info.resetAt.getTime()) : null;
    let resumeAtMs: number;
    if (info.resetAt) {
      resumeAtMs = info.resetAt.getTime() + this.rl.reset_margin_seconds * 1000;
      this.backoffMs = this.rl.unparsed_retry_initial_seconds * 1000;
    } else {
      resumeAtMs = now + this.backoffMs;
      this.host.log.warn("ratelimit.unparsed", `couldn't read the reset time; trying again in ${Math.round(this.backoffMs / 60000)} min`, { backoffMs: this.backoffMs, message: clip(text, 300) });
      this.backoffMs = Math.min(this.backoffMs * 2, this.rl.unparsed_retry_max_seconds * 1000);
    }
    const patch: DeepPartial<DashState> = {
      rateLimit: {
        status: "waiting",
        reason: info.label,
        message: clip(info.raw, 300),
        source,
        detectedAt: iso(this.limitAtMs || now),
        resetAt,
        resumeAt: iso(resumeAtMs),
        waitStartedAt: r.waitStartedAt ?? iso(now),
        holding: false,
      },
    };
    if (info.kind === "session") patch.rateLimit!.sessionResetAt = resetAt;
    if (info.kind === "weekly") patch.rateLimit!.weeklyResetAt = resetAt;
    if (info.kind === "model") patch.rateLimit!.modelResetAt = resetAt;
    this.host.patch(patch);

    if (this.rl.prevent_system_sleep && !this.st.rateLimit.caffeinatePid) {
      const pid = this.host.startCaffeinate();
      this.host.patch({ rateLimit: { caffeinatePid: pid } });
      if (pid) this.host.log.info("caffeinate.started", `caffeinate -i started (pid ${pid}) while waiting`, { pid });
    }

    const pct = r.weeklyPct;
    if (info.kind === "weekly" && pct !== null && pct >= cb.weekly_quota_stop_pct) {
      this.host.log.error("breaker.tripped", `weekly quota ${pct}% ≥ ${cb.weekly_quota_stop_pct}%: not resuming`, { pct, stop: cb.weekly_quota_stop_pct });
      this.host.patch({ rateLimit: { resumeAt: null } });
      this.pause("ratelimit", `weekly quota ${pct}% reached`);
      this.notify("csuper: weekly quota", `Weekly usage at ${pct}% (stop at ${cb.weekly_quota_stop_pct}%). Autopilot paused instead of resuming.`);
      return;
    }
    if (!this.rl.auto_resume) {
      this.host.log.info("ratelimit.resume_scheduled", "auto_resume is off: waiting for skip-wait (w in csuper dash)");
      return;
    }
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = setTimeout(() => this.resume("reset time reached"), Math.max(0, resumeAtMs - now));
    this.host.log.info("ratelimit.resume_scheduled", `resume at ${iso(resumeAtMs)}${info.resetAt ? ` (reset + ${this.rl.reset_margin_seconds} s)` : " (retry)"}`, {
      resumeAt: iso(resumeAtMs),
      resetAt,
      parsed: !!info.resetAt,
    });
  }

  /** Send resume_prompt and verify: a new turn starts, and no limit message follows within resume_verify_seconds. */
  private resume(why: string, force = false): void {
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
    const s = this.st;
    if (!force && !s.autopilot.enabled) {
      this.host.patch({ rateLimit: { holding: true } });
      this.host.log.info("ratelimit.resume_scheduled", `reset time reached but autopilot is ${s.autopilot.pausedReason ?? "paused"}: resuming when autopilot resumes`);
      return;
    }
    if (this.lastActivityAt > this.limitAtMs && this.limitAtMs > 0 && why !== "model failover") {
      return this.resumeSucceeded("claude continued on its own");
    }
    const attempts = (s.rateLimit.resumeAttempts ?? 0) + 1;
    this.host.patch({ rateLimit: { status: "resuming", resumeAttempts: attempts, holding: false, resumeAt: null } });
    this.host.log.info("ratelimit.resume_sent", `resume #${attempts} (${why}): sending "${this.rl.resume_prompt}"`, { attempt: attempts, why });
    this.phase = "await_turn";
    if (this.turnTimer) clearTimeout(this.turnTimer);
    this.turnTimer = setTimeout(() => this.resumeUnconfirmed(), this.stepTimeout);
    this.type(this.rl.resume_prompt);
  }

  private resumeTurnStarted(): void {
    if (this.turnTimer) clearTimeout(this.turnTimer);
    this.turnTimer = null;
    this.phase = "verify";
    this.host.log.info("ratelimit.resume_turn", `resume confirmed: new turn started; watching ${this.rl.resume_verify_seconds} s for a new limit`);
    if (this.verifyTimer) clearTimeout(this.verifyTimer);
    this.verifyTimer = setTimeout(() => this.resumeSucceeded(`no limit message within ${this.rl.resume_verify_seconds} s`), this.rl.resume_verify_seconds * 1000);
  }

  private clearResumeTimers(): void {
    for (const t of [this.turnTimer, this.verifyTimer]) if (t) clearTimeout(t);
    this.turnTimer = this.verifyTimer = null;
    this.phase = "idle";
  }

  private resumeUnconfirmed(): void {
    this.clearResumeTimers();
    const why = `"${this.rl.resume_prompt}" sent but no new turn within ${Math.round(this.stepTimeout / 1000)} s`;
    this.host.log.error("ratelimit.resume_failed", `resume not confirmed: ${why}`, { reason: why });
    this.host.patch({ rateLimit: { status: "waiting", resumeAt: null } });
    this.pause("ratelimit", "resume not confirmed");
    this.notify("csuper: resume failed", `${why}. Autopilot paused.`);
  }

  private resumeFailed(info: LimitInfo, source: "hook" | "pty"): void {
    this.clearResumeTimers();
    // Only a resume made at a parsed reset time counts. A backoff retry for an unreadable
    // time is expected to hit the limit again, and those never stop for good.
    const counted = !!this.st.rateLimit.resetAt;
    const failed = (this.st.rateLimit.failedResumes ?? 0) + (counted ? 1 : 0);
    const max = this.rl.max_failed_resumes;
    this.host.patch({ rateLimit: { failedResumes: failed, status: "waiting" } });
    this.limitAtMs = Date.now();
    this.host.log.warn("ratelimit.resume_failed", `still limited after resume (${failed}/${max} in a row): ${info.label}${info.resetText ? ` · resets ${info.resetText}` : ""}`, {
      failed,
      max,
      resetText: info.resetText,
    });
    if (failed >= max) {
      this.host.patch({ rateLimit: { resumeAt: null, reason: info.label, message: clip(info.raw, 300) } });
      this.pause("ratelimit", `${failed} resumes in a row hit the limit`);
      this.notify("csuper: still rate-limited", `${failed} resumes in a row hit the limit (${info.label}). Autopilot paused.`);
      return;
    }
    const to = this.failoverTarget(info);
    if (to) {
      void this.failover(info, to);
      return;
    }
    this.schedule(info, source, info.raw);
  }

  private resumeSucceeded(why: string): void {
    this.clearResumeTimers();
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
    const r = this.st.rateLimit;
    const waited = r.waitStartedAt ? Date.now() - Date.parse(r.waitStartedAt) : 0;
    const onFallback = !!r.modelRestoreAt || ((r.failovers ?? []).at(-1)?.restoredAt === null && (r.failovers ?? []).length > 0);
    this.host.stopCaffeinate();
    this.host.patch({
      rateLimit: {
        status: onFallback ? "failover" : "ok",
        resumeAt: null,
        waitStartedAt: null,
        holding: false,
        resumeAttempts: 0,
        failedResumes: 0,
        caffeinatePid: null,
        totalWaitMs: (r.totalWaitMs ?? 0) + waited,
      },
    });
    this.backoffMs = this.rl.unparsed_retry_initial_seconds * 1000;
    this.limitAtMs = 0;
    this.host.log.info("ratelimit.resumed", `resumed: ${why} (waited ${Math.round(waited / 1000)} s)`, { why, waitedMs: waited });
  }
}

function summarize(i: LimitInfo | null): Record<string, unknown> | null {
  if (!i) return null;
  return { kind: i.kind, label: i.label, model: i.model, resetText: i.resetText, resetAt: i.resetAt ? i.resetAt.toISOString() : null };
}

/** Text just before the keyword, for the notification body. */
function lastLines(text: string, keyword: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && l !== keyword);
  return lines.slice(-2).join(" ").replace(keyword, "").trim();
}
