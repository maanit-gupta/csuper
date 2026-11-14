/**
 * In-process stand-in for `claude` under csuper, for the autopilot tests (fake timers).
 *
 * It reads what csuper types into the PTY (text, then Enter) and answers like Claude
 * Code 2.1.325 does: the same hook payloads (via hooks/csuper-hook.js field names) and
 * real-looking terminal output, including the usage-limit banner with ANSI codes.
 */
import { defaultConfig, type Config } from "../src/config.js";
import { Autopilot, type HookMsg, type Host } from "../src/supervisor/autopilot.js";
import { applyPatch, initialState, type DashState, type DeepPartial } from "../src/state.js";

export type ResumeOutcome = { kind: "ok"; reply?: string } | { kind: "limited"; banner: string } | { kind: "ignore" };

export interface StubOptions {
  config?: (c: Config) => void;
  /** /clear: answer with SessionStart(source=clear) (default) or never confirm it. */
  clear?: "confirm" | "ignore";
  /** /next: start a turn (default) or ignore it. */
  next?: "confirm" | "ignore";
  /** /next's reply, sent as the Stop hook's last_assistant_message after `turnMs`. Null = the turn doesn't end on its own. */
  nextReply?: string | null;
  /** How the stub answers resume_prompt, one entry per resume (the last repeats). */
  resume?: ResumeOutcome[];
  model?: string;
  /** Hook latency (ms). */
  hookMs?: number;
  /** Turn length (ms). */
  turnMs?: number;
  /** Fire hooks at all (false = only the screen shows anything, like a claude without our --settings). */
  hooks?: boolean;
}

export const BANNER = (text: string) => `\x1b[2K\x1b[1G  \x1b[38;5;246m⎿\x1b[39m  \x1b[31m${text.replace(/ /g, "\x1b[1C")}\x1b[39m\r\n`;

export class StubClaude {
  state: DashState;
  config: Config;
  engine: Autopilot;
  typed: string[] = [];
  screen: string[] = [];
  logs: Array<{ level: string; event: string; msg: string; data?: Record<string, unknown> }> = [];
  notifications: Array<{ title: string; message: string }> = [];
  samples: Record<string, unknown>[] = [];
  caffeinate: { running: boolean; starts: number; stops: number } = { running: false, starts: 0, stops: 0 };
  checkpoints = 0;
  private input = "";
  private lastOut = 0;
  private resumeCount = 0;

  constructor(private o: StubOptions = {}) {
    this.config = defaultConfig();
    o.config?.(this.config);
    this.state = initialState({ id: "a1b2c3", cwd: "/tmp/proj", pid: 1, claudePid: 2, startedAt: new Date().toISOString(), version: "test" });
    this.state.cycles.max = this.config.rate_limits.circuit_breakers.max_auto_cycles_per_session;
    this.state.rateLimit.weeklyStopPct = this.config.rate_limits.circuit_breakers.weekly_quota_stop_pct;
    this.state.model = o.model ?? "claude-opus-5-5";
    const log = (level: string) => (event: string, msg: string, data?: Record<string, unknown>) => {
      this.logs.push({ level, event, msg, data });
    };
    const host: Host = {
      write: (d) => this.onWrite(d),
      getState: () => this.state,
      patch: (p: DeepPartial<DashState>) => {
        this.state = applyPatch(this.state, p);
      },
      log: { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") },
      notify: (title, message) => this.notifications.push({ title, message }),
      startCaffeinate: () => {
        this.caffeinate.running = true;
        this.caffeinate.starts++;
        return 4321;
      },
      stopCaffeinate: () => {
        if (this.caffeinate.running) this.caffeinate.stops++;
        this.caffeinate.running = false;
      },
      gitCheckpoint: async () => {
        this.checkpoints++;
        return { sha: "abc1234", files: 3 };
      },
      saveHandover: () => "/tmp/proj/.claude/csuper-handovers/x.md",
      saveSample: (r) => this.samples.push(r),
      lastOutputAt: () => this.lastOut,
    };
    this.engine = new Autopilot(host, this.config);
  }

  // ---------------------------------------------------------------- claude's side

  /** claude prints something (PTY output). */
  print(text: string): void {
    this.lastOut = Date.now();
    this.screen.push(text);
    this.engine.onPtyData(text);
  }

  /** A hook fires (after the hook script's latency). */
  hook(m: Omit<HookMsg, "type">): void {
    if (this.o.hooks === false) return;
    setTimeout(() => this.engine.onHook({ type: "hook", ...m }), this.o.hookMs ?? 30);
  }

  /** The current turn ends with this final message. */
  finishTurn(text: string): void {
    this.print(`⏺ ${text.split("\n")[0]}\r\n`);
    this.hook({ event: "Stop", last_assistant_message: text });
  }

  /** The current turn is stopped by a usage limit: banner on screen + StopFailure hook. */
  hitLimit(text: string): void {
    this.print(BANNER(text));
    this.hook({ event: "StopFailure", stop_error: "rate_limit", error_details: '429 {"type":"error","error":{"type":"rate_limit_error"}}', last_assistant_message: text });
  }

  private turn(prompt: string, viaExpansion = false): void {
    if (viaExpansion) this.hook({ event: "UserPromptExpansion", command_name: prompt.slice(1).split(" ")[0], prompt });
    this.hook({ event: "UserPromptSubmit", prompt });
    this.print(`> ${prompt}\r\n✻ Working…\r\n`);
  }

  private onWrite(d: string): void {
    for (const ch of d) {
      if (ch === "\r") {
        const line = this.input;
        this.input = "";
        this.typed.push(line);
        this.onLine(line.trim());
      } else this.input += ch;
    }
  }

  private onLine(line: string): void {
    const turnMs = this.o.turnMs ?? 2000;
    if (line === "/clear") {
      if (this.o.clear === "ignore") return;
      this.print("\x1b[2J\x1b[H(no content)\r\n");
      this.hook({ event: "SessionStart", source: "clear", model: this.state.model });
      return;
    }
    if (line.startsWith("/model ")) {
      const fam = line.slice(7).trim();
      const to = `claude-${fam}-5-5`;
      this.print(`  ⎿  Set model to ${fam[0].toUpperCase()}${fam.slice(1)} 5.5\r\n`);
      this.hook({ event: "PostModelSwitch", from_model: this.state.model, to_model: to });
      return;
    }
    if (line === "/next") {
      if (this.o.next === "ignore") return;
      this.turn("/next", true);
      const reply = this.o.nextReply === undefined ? "Starting Phase 3: Auth refactor. Reading the plan first." : this.o.nextReply;
      if (reply !== null) setTimeout(() => this.finishTurn(reply), turnMs);
      return;
    }
    if (line === this.config.rate_limits.resume_prompt) {
      const list = this.o.resume ?? [{ kind: "ok" }];
      const out = list[Math.min(this.resumeCount++, list.length - 1)];
      if (out.kind === "ignore") return;
      this.turn(line);
      if (out.kind === "limited") setTimeout(() => this.hitLimit(out.banner), 300);
      else setTimeout(() => this.finishTurn(out.reply ?? "Continuing where I left off."), turnMs);
      return;
    }
  }

  // ---------------------------------------------------------------- assertions

  events(name: string) {
    return this.logs.filter((l) => l.event === name);
  }
  stepsOk(cycle = 1): string[] {
    return this.events("cycle.step")
      .filter((l) => l.data?.cycle === cycle && l.data?.status === "ok")
      .map((l) => `${l.data!.n}/${l.data!.total} ${l.data!.step}`);
  }
}
