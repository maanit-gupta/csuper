/**
 * CLI glue for the supervisor (bundled as dist/supervise.js, loaded on demand):
 *
 *   csuper [claude-args]          run a new claude under csuper
 *   csuper adopt …                continue existing conversations under csuper
 *   csuper resume [<id>] …        alias for `adopt <id> --here` in this folder
 */
import { runSupervisor } from "../supervisor/supervisor.js";
import { runAdoptCli } from "./adopt.js";

export async function runNew(claudeArgs: string[], version: string): Promise<number> {
  return runSupervisor({ claudeArgs, version });
}

export async function runAdopt(argv: string[], version: string): Promise<number> {
  return runAdoptCli(argv, version, false);
}

/** `csuper resume` keeps its name and flags, but runs through adopt (one code path). */
export async function runResume(argv: string[], version: string): Promise<number> {
  return runAdoptCli(argv, version, true);
}
