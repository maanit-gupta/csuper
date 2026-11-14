import { parseArgs } from "node:util";
import { defaultConfig, loadConfig, type Config } from "../config.js";
import { runCtl } from "./ctl.js";
import { runLogs } from "./logs.js";
import { runSessions } from "./sessions.js";
import { runStatus } from "./status.js";

declare const __CSUPER_VERSION__: string | undefined;
/** Injected by scripts/build.mjs from package.json; "dev" when run from source. */
export const VERSION = typeof __CSUPER_VERSION__ === "string" ? __CSUPER_VERSION__ : "dev";

export const DASH_COMMANDS = ["dash", "status", "logs", "sessions", "ctl"] as const;

const USAGE = `csuper — supervise Claude Code

  csuper [claude-args]          run claude under csuper (args go to claude)
  csuper adopt [<id>…] [--latest|--all-live] [--stop-original] [--fork]
               [--compact] [--autopilot|--paused] [--here|--tabs] [--dry-run]
                                continue existing Claude Code conversations under csuper
  csuper resume [<id>] [--fork] [--list] [-- claude-args]
                                same as \`adopt <id> --here\` for this folder
  csuper --version

Dashboard (run in another terminal):

  csuper dash     [--session <id>]
  csuper sessions [--json] [--prune]
  csuper status   [--session <id>] [--json]
  csuper logs     [--session <id>] [-f|--follow] [--level info|warn|error]
                  [--event <name>] [--since 10m|2h|<ISO>] [-n 200] [--raw]
  csuper ctl      [--session <id>] pause|resume|cancel-countdown|skip-wait [--yes]

Environment: CSUPER_HOME, CSUPER_SESSION, CSUPER_CONFIG, CSUPER_CLAUDE_BIN, CSUPER_TAB_LAUNCHER,
             CSUPER_NOTIFY_LOG (write notifications to a file instead of showing them), NO_COLOR`;

function quietConfig(): Config {
  try {
    return loadConfig().config;
  } catch (e) {
    process.stderr.write(`csuper: ignoring invalid config (${(e as Error).message.split("\n")[0]})\n`);
    return defaultConfig();
  }
}

/** Decide color once, before Ink/chalk load: config `color`, then NO_COLOR, then TTY detection. */
export function useColor(setting: "auto" | "always" | "never", isTTY: boolean): boolean {
  if (setting === "never") return false;
  if (setting === "always") return true;
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return false;
  return isTTY;
}

/**
 * Run a dashboard subcommand. Returns the exit code, or null when `argv[0]` is not
 * a dashboard command (so the core supervisor's CLI can handle it).
 */
export async function runDashboardCli(argv: string[]): Promise<number | null> {
  const [cmd, ...rest] = argv;
  if (!(DASH_COMMANDS as readonly string[]).includes(cmd)) return null;
  const session = { session: { type: "string" as const } };
  try {
    switch (cmd) {
      case "dash": {
        const { values } = parseArgs({ args: rest, options: session });
        const cfg = quietConfig();
        const color = useColor(cfg.dashboard.color, !!process.stdout.isTTY);
        process.env.FORCE_COLOR = color ? "3" : "0"; // read by chalk when the TUI bundle loads
        const { runDash } = await import("./dash.js");
        return await runDash({ session: values.session });
      }
      case "status": {
        const { values } = parseArgs({ args: rest, options: { ...session, json: { type: "boolean" } } });
        return await runStatus({ session: values.session, json: values.json, timeFormat: quietConfig().dashboard.time_format });
      }
      case "sessions": {
        const { values } = parseArgs({ args: rest, options: { json: { type: "boolean" }, prune: { type: "boolean" } } });
        return await runSessions(values);
      }
      case "logs": {
        const { values } = parseArgs({
          args: rest,
          options: {
            ...session,
            follow: { type: "boolean", short: "f" },
            level: { type: "string" },
            event: { type: "string" },
            since: { type: "string" },
            n: { type: "string", short: "n" },
            raw: { type: "boolean" },
          },
        });
        const n = values.n === undefined ? 200 : Number(values.n);
        if (!Number.isInteger(n) || n < 0) {
          process.stderr.write("csuper logs: -n must be a non-negative integer\n");
          return 64;
        }
        const cfg = quietConfig();
        return await runLogs({
          ...values,
          n,
          color: useColor(cfg.dashboard.color, !!process.stdout.isTTY),
          timeFormat: cfg.dashboard.time_format,
        });
      }
      case "ctl": {
        const { values, positionals } = parseArgs({
          args: rest,
          options: { ...session, yes: { type: "boolean", short: "y" } },
          allowPositionals: true,
        });
        return await runCtl({
          verb: positionals[0],
          session: values.session,
          yes: values.yes,
          confirmSkipWait: quietConfig().dashboard.confirm_skip_wait,
        });
      }
    }
  } catch (e) {
    const err = e as { code?: string; message: string };
    if (err.code?.startsWith("ERR_PARSE_ARGS")) {
      process.stderr.write(`csuper ${cmd}: ${err.message}\n\n${USAGE}\n`);
      return 64;
    }
    throw e;
  }
  return null;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "--version" || argv[0] === "-V") {
    process.stdout.write(`csuper ${VERSION}\n`);
    return 0;
  }
  if (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    process.stdout.write(USAGE + "\n");
    return 0;
  }
  const code = await runDashboardCli(argv);
  if (code !== null) return code;
  const { runNew, runResume, runAdopt } = await import("./supervise.js");
  if (argv[0] === "resume") return runResume(argv.slice(1), VERSION);
  if (argv[0] === "adopt") return runAdopt(argv.slice(1), VERSION);
  return runNew(argv, VERSION);
}

// Only run when executed directly (bundled bin or `tsx src/cli/main.ts`), not when imported.
const entry = process.argv[1] ?? "";
if (/csuper(\.js)?$|main\.ts$/.test(entry)) {
  main().then(
    (code) => {
      // Let stdout flush before exiting.
      process.exitCode = code;
      if (process.stdout.writableLength === 0) process.exit(code);
      else process.stdout.once("drain", () => process.exit(code));
    },
    (e) => {
      process.stderr.write(`csuper: ${(e as Error).stack ?? e}\n`);
      process.exit(1);
    },
  );
}
