import readline from "node:readline";
import type { ControlAction } from "../protocol.js";
import { sendControl } from "./client.js";
import { pickSession, stdio, type Io } from "./common.js";

export const CTL_VERBS: Record<string, ControlAction> = {
  pause: "autopilot.pause",
  resume: "autopilot.resume",
  "cancel-countdown": "countdown.cancel",
  "skip-wait": "ratelimit.skip_wait",
};

export interface CtlOpts {
  verb: string | undefined;
  session?: string;
  yes?: boolean;
  confirmSkipWait?: boolean;
  sessionsDir?: string;
  /** Injected for tests; defaults to a y/N prompt on the TTY. */
  confirm?: (question: string) => Promise<boolean>;
}

export function askYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return Promise.resolve(false);
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(`${question} [y/N] `, (a) => {
      rl.close();
      resolve(/^y(es)?$/i.test(a.trim()));
    });
  });
}

export async function runCtl(opts: CtlOpts, io: Io = stdio): Promise<number> {
  const action = opts.verb ? CTL_VERBS[opts.verb] : undefined;
  if (!action) {
    io.err(`csuper ctl: expected one of: ${Object.keys(CTL_VERBS).join(", ")}`);
    return 64;
  }
  const picked = await pickSession(opts.session, io, opts.sessionsDir);
  if (typeof picked === "number") return picked;
  if (picked.status === "stale") {
    io.err(`csuper: session ${picked.id} is not responding (stale: ${picked.staleReason})`);
    return 4;
  }
  if (action === "ratelimit.skip_wait" && (opts.confirmSkipWait ?? true) && !opts.yes) {
    const confirm = opts.confirm ?? askYesNo;
    const ok = await confirm("Skip the rate-limit wait and send resume_prompt now? It may hit the limit again.");
    if (!ok) {
      io.err("cancelled (use --yes to skip the prompt)");
      return 1;
    }
  }
  try {
    const ack = await sendControl(picked.sockPath, action);
    if (!ack.ok) {
      io.err(`csuper: ${action} failed: ${ack.error}`);
      return 1;
    }
    io.out(`ok: ${action} (session ${picked.id})`);
    return 0;
  } catch (e: any) {
    io.err(`csuper: session ${picked.id} is not responding (${e?.code ?? e?.message})`);
    return 4;
  }
}
