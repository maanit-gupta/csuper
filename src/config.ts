import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { csuperHome, expandHome } from "./paths.js";

/**
 * zod schema for csuper.config.yaml. Only the sections the dashboard owns or
 * changes are modelled strictly; other core sections pass through untouched.
 * Every key here must also exist in csuper.config.yaml (docs/dashboard-spec.md §8.5).
 */
export const LOG_LEVEL_FILTERS = ["all", "info", "warn", "error"] as const;
export type LogLevelFilter = (typeof LOG_LEVEL_FILTERS)[number];

export const DashboardConfigSchema = z
  .object({
    refresh_fallback_ms: z.number().int().min(100).max(60_000).default(1000),
    log_tail_lines: z.number().int().min(10).max(100_000).default(500),
    default_log_level: z.enum(LOG_LEVEL_FILTERS).default("info"),
    recent_triggers_shown: z.number().int().min(1).max(100).default(10),
    handover_preview_lines: z.number().int().min(1).max(500).default(15),
    confirm_skip_wait: z.boolean().default(true),
    color: z.enum(["auto", "always", "never"]).default("auto"),
    time_format: z.enum(["24h", "12h"]).default("24h"),
  })
  .strict();

export const GeneralConfigSchema = z
  .object({
    csuper_home: z.string().default("~/.csuper"),
    socket_dir: z.string().default("~/.csuper/sessions"),
    log_dir: z.string().default("~/.csuper/logs"),
    log_max_bytes: z.number().int().min(1024).default(10_485_760),
    log_keep_files: z.number().int().min(1).max(100).default(5),
    subscriber_buffer_msgs: z.number().int().min(10).max(1_000_000).default(1000),
    reconnect_max_backoff_ms: z.number().int().min(250).max(300_000).default(10_000),
  })
  .passthrough();

/** Anomaly breaker. Must be positive (0 is rejected, not read as "unlimited"). [FILL: confirm against the core spec] */
export const AnomaliesConfigSchema = z
  .object({
    max_consecutive_tool_failures: z.number().int().min(1).max(1000).default(5),
  })
  .passthrough();

/**
 * Keyword triggers, matched against the last line of claude's final message (Stop hook).
 * Names and defaults follow the core csuper spec.
 */
export const TriggerSchema = z
  .object({
    name: z.string().min(1),
    keyword: z.string().min(1),
    match_mode: z.enum(["last_line"]).default("last_line"),
    enabled: z.boolean().default(true),
    save_handover: z.boolean().default(false),
    git_checkpoint: z.boolean().default(false),
    pause_autopilot: z.boolean().default(false),
    notify_macos: z.boolean().default(false),
    commands: z.array(z.string().min(1)).default([]),
  })
  .strict();

export const DEFAULT_TRIGGERS: z.input<typeof TriggerSchema>[] = [
  { name: "task_complete", keyword: "::DONE::", match_mode: "last_line", enabled: true, save_handover: true, git_checkpoint: true, commands: ["/clear", "/next"] },
  { name: "human_escalation", keyword: "::BLOCKED::", match_mode: "last_line", pause_autopilot: true, notify_macos: true, commands: [] },
  { name: "all_complete", keyword: "::COMPLETE::", match_mode: "last_line", pause_autopilot: true, notify_macos: true, commands: [] },
];

/** `HH:MM-HH:MM` (may wrap midnight) or `always`. */
const ACTIVE_HOURS = /^(always|([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d)$/;

export const CircuitBreakersSchema = z
  .object({
    /** Successful /clear→/next cycles before autopilot stops itself. Must be ≥ 1. */
    max_auto_cycles_per_session: z.number().int().min(1).max(10_000).default(20),
    /** Pause instead of resuming once weekly usage reaches this %. Has no data source yet. */
    weekly_quota_stop_pct: z.number().min(1).max(100).default(85),
    active_hours: z.string().regex(ACTIVE_HOURS, "active_hours must be `always` or HH:MM-HH:MM").default("always"),
  })
  .strict();

export const RateLimitsConfigSchema = z
  .object({
    auto_resume: z.boolean().default(true),
    resume_prompt: z.string().min(1).default("continue"),
    reset_margin_seconds: z.number().int().min(0).max(3600).default(90),
    /** Run `caffeinate -i` while waiting for a reset. */
    prevent_system_sleep: z.boolean().default(true),
    model_failover_order: z.array(z.string().min(1)).default(["opus", "sonnet"]),
    circuit_breakers: CircuitBreakersSchema.default({}),
    /** After a resume: a new limit message within this window means the resume failed. */
    resume_verify_seconds: z.number().int().min(5).max(600).default(60),
    /** Consecutive failed resumes before autopilot pauses and notifies. */
    max_failed_resumes: z.number().int().min(1).max(100).default(3),
    /** Reset time not parseable: retry after this, doubling each time… */
    unparsed_retry_initial_seconds: z.number().int().min(10).max(86_400).default(300),
    /** …up to this ceiling. It never gives up. */
    unparsed_retry_max_seconds: z.number().int().min(10).max(86_400).default(1800),
    /** A banner seen only in the PTY is acted on if no hook reports the limit within this time. */
    pty_fallback_grace_ms: z.number().int().min(0).max(60_000).default(5000),
  })
  .strict();

/** The checked /clear→/next cycle. Other core keys in this section pass through untouched. */
export const AutopilotConfigSchema = z
  .object({
    /** Each cycle step must be confirmed within this time, or the cycle fails and autopilot pauses. */
    cycle_step_timeout_ms: z.number().int().min(1000).max(600_000).default(30_000),
    /** "claude idle" = no terminal output for this long. */
    idle_quiet_ms: z.number().int().min(100).max(30_000).default(1500),
  })
  .passthrough();

/** `csuper adopt` / `csuper resume`. */
export const AdoptConfigSchema = z
  .object({
    default_autopilot: z.boolean().default(false),
    default_open_mode: z.enum(["tabs", "here"]).default("tabs"),
    compact_on_adopt: z.boolean().default(false),
    stop_wait_timeout_ms: z.number().int().min(1000).max(300_000).default(10_000),
    scan_limit: z.number().int().min(1).max(1000).default(50),
  })
  .strict();

export const ConfigSchema = z
  .object({
    general: GeneralConfigSchema.default({}),
    autopilot: AutopilotConfigSchema.default({}),
    anomalies: AnomaliesConfigSchema.default({}),
    adopt: AdoptConfigSchema.default({}),
    dashboard: DashboardConfigSchema.default({}),
    triggers: z.array(TriggerSchema).default(DEFAULT_TRIGGERS as any),
    /** Countdown between a trigger and its first command; `c` in dash cancels it. */
    pre_clear_delay_ms: z.number().int().min(0).max(600_000).default(5000),
    rate_limits: RateLimitsConfigSchema.default({}),
  })
  .passthrough()
  .superRefine((c, ctx) => {
    const seen = new Set<string>();
    for (const t of c.triggers) {
      if (seen.has(t.keyword)) ctx.addIssue({ code: "custom", path: ["triggers"], message: `duplicate trigger keyword ${t.keyword}` });
      seen.add(t.keyword);
    }
  });

export type Config = z.infer<typeof ConfigSchema>;
export type DashboardConfig = z.infer<typeof DashboardConfigSchema>;
export type GeneralConfig = z.infer<typeof GeneralConfigSchema>;
export type AdoptConfig = z.infer<typeof AdoptConfigSchema>;
export type TriggerConfig = z.infer<typeof TriggerSchema>;
export type RateLimitsConfig = z.infer<typeof RateLimitsConfigSchema>;

export function defaultConfig(): Config {
  return ConfigSchema.parse({});
}

export function parseConfig(text: string): Config {
  const raw = YAML.parse(text) ?? {};
  return ConfigSchema.parse(raw);
}

/** Candidate config locations, most specific first. */
export function configCandidates(explicit?: string | null): string[] {
  const list: string[] = [];
  if (explicit) list.push(expandHome(explicit));
  if (process.env.CSUPER_CONFIG) list.push(expandHome(process.env.CSUPER_CONFIG));
  list.push(path.resolve("csuper.config.yaml"));
  list.push(path.join(csuperHome(), "csuper.config.yaml"));
  return list;
}

/** Load the first config file found; fall back to defaults. Throws on invalid YAML/schema. */
export function loadConfig(explicit?: string | null): { config: Config; path: string | null } {
  for (const p of configCandidates(explicit)) {
    if (fs.existsSync(p)) return { config: parseConfig(fs.readFileSync(p, "utf8")), path: p };
  }
  return { config: defaultConfig(), path: null };
}
