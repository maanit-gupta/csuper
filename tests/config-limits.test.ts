import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { fetchSnapshot } from "../src/cli/client.js";
import { loadConfig, parseConfig } from "../src/config.js";
import { IpcServer } from "../src/ipc-server.js";
import { sessionInitialState, toolFailureBreakerTrips } from "../src/supervisor/supervisor.js";
import { tmpHome } from "./fixtures.js";

const REPO_CONFIG = path.resolve(__dirname, "..", "csuper.config.yaml");
const session = { id: "a1b2c3", cwd: "/tmp/p", pid: 1, claudePid: 2, startedAt: "2026-11-14T07:30:00.000Z", version: "test" };

let home: string | null = null;
let server: IpcServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
  if (home) fs.rmSync(home, { recursive: true, force: true });
  home = null;
});

describe("circuit-breaker limits reach the status snapshot", () => {
  it("csuper.config.yaml → supervisor state → `status --json` snapshot", async () => {
    const raw = YAML.parse(fs.readFileSync(REPO_CONFIG, "utf8"));
    const wantCycles = raw.rate_limits.circuit_breakers.max_auto_cycles_per_session;
    const wantFails = raw.anomalies.max_consecutive_tool_failures;
    expect(wantCycles).toBeGreaterThan(0);
    expect(wantFails).toBeGreaterThan(0);

    const { config } = loadConfig(REPO_CONFIG);
    home = tmpHome("csl-");
    const sock = path.join(home, "s.sock");
    server = new IpcServer({ sockPath: sock, initialState: sessionInitialState(config, session, []) });
    await server.listen();
    const { state } = await fetchSnapshot(sock);
    expect(state.cycles).toEqual({ used: 0, max: wantCycles, failed: 0, lastOkAt: null, current: null, recent: [] });
    expect(state.rateLimit.weeklyStopPct).toBe(raw.rate_limits.circuit_breakers.weekly_quota_stop_pct);
    expect(state.activeHours).toEqual({ window: "always", inside: true });
    expect(state.anomalies.threshold).toBe(wantFails);
  });

  it("missing keys fall back to non-zero defaults; 0 is rejected", () => {
    const c = parseConfig("dashboard: {}\n");
    expect(c.rate_limits.circuit_breakers.max_auto_cycles_per_session).toBeGreaterThan(0);
    expect(c.anomalies.max_consecutive_tool_failures).toBeGreaterThan(0);
    expect(() => parseConfig("rate_limits:\n  circuit_breakers:\n    max_auto_cycles_per_session: 0\n")).toThrow();
    expect(() => parseConfig("anomalies:\n  max_consecutive_tool_failures: 0\n")).toThrow();
  });

  it("the tool-failure breaker trips at the threshold", () => {
    expect(toolFailureBreakerTrips(4, 5)).toBe(false);
    expect(toolFailureBreakerTrips(5, 5)).toBe(true);
    expect(toolFailureBreakerTrips(9, 0)).toBe(false);
  });

  it("autopilot can start paused", () => {
    const { config } = loadConfig(REPO_CONFIG);
    expect(sessionInitialState(config, session, [], false).autopilot).toEqual({ enabled: false, pausedReason: "user" });
  });

  it("the repo config matches the core spec's trigger and rate_limits names and values", () => {
    const { config } = loadConfig(REPO_CONFIG);
    expect(config.triggers).toEqual([
      { name: "task_complete", keyword: "::DONE::", match_mode: "last_line", enabled: true, save_handover: true, git_checkpoint: true, pause_autopilot: false, notify_macos: false, commands: ["/clear", "/next"] },
      { name: "human_escalation", keyword: "::BLOCKED::", match_mode: "last_line", enabled: true, save_handover: false, git_checkpoint: false, pause_autopilot: true, notify_macos: true, commands: [] },
      { name: "all_complete", keyword: "::COMPLETE::", match_mode: "last_line", enabled: true, save_handover: false, git_checkpoint: false, pause_autopilot: true, notify_macos: true, commands: [] },
    ]);
    expect(config.pre_clear_delay_ms).toBe(5000);
    expect(config.rate_limits).toMatchObject({
      auto_resume: true,
      resume_prompt: "continue",
      reset_margin_seconds: 90,
      prevent_system_sleep: true,
      model_failover_order: ["opus", "sonnet"],
      circuit_breakers: { max_auto_cycles_per_session: 20, weekly_quota_stop_pct: 85, active_hours: "always" },
    });
    expect(config.autopilot.cycle_step_timeout_ms).toBe(30_000);
    // With no config file at all, the defaults are the same.
    const d = parseConfig("{}\n");
    expect(d.triggers).toEqual(config.triggers);
    expect(d.rate_limits).toEqual(config.rate_limits);
  });

  it("rejects a bad active_hours and duplicate keywords", () => {
    expect(() => parseConfig("rate_limits:\n  circuit_breakers:\n    active_hours: 9-5\n")).toThrow();
    expect(parseConfig("rate_limits:\n  circuit_breakers:\n    active_hours: 22:00-06:00\n").rate_limits.circuit_breakers.active_hours).toBe("22:00-06:00");
    expect(() => parseConfig('triggers:\n  - {name: a, keyword: "::X::"}\n  - {name: b, keyword: "::X::"}\n')).toThrow(/duplicate/);
  });
});
