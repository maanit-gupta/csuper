#!/usr/bin/env node
// Stand-in for `claude` in the e2e suite (CSUPER_CLAUDE_BIN). Prints what csuper gave
// it, then reads commands line by line from its pty:
//   fail | ok | edit   run csuper's hook (from --settings) like Claude Code would
//   size               print the pty size
//   quit <n>           exit with code n
// Autopilot (hook payloads as Claude Code 2.1.325 sends them):
//   done               end the turn: Stop with a final message ending in ::DONE::
//   limit <message>    usage limit: print the banner, then StopFailure (error rate_limit)
//   noclear            toggle: ignore /clear (never confirm it)
//   limited-resumes N  the next N resume prompts hit the limit again
//   /clear             SessionStart(source=clear)      — typed by csuper
//   /next              UserPromptExpansion + UserPromptSubmit, then Stop with "Starting Phase 2: Wiring"
//   /model <m>         PostModelSwitch to claude-<m>-5-5 + "Set model to …"
//   continue           UserPromptSubmit, then Stop (or the limit again, see limited-resumes)
//
// Like Claude Code 2.1.x it keeps $CLAUDE_CONFIG_DIR/sessions/<pid>.json while running
// (removed on exit, including SIGTERM → exit 143), keeps the conversation ID on
// --resume and makes a new one with --fork-session. With FAKE_CLAUDE_PROMPT set, a new
// session writes a transcript with that first prompt, so it can be adopted later.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const args = process.argv.slice(2);
let hookCmd = null;
const si = args.indexOf("--settings");
if (si >= 0) {
  hookCmd = JSON.parse(args[si + 1]).hooks.PostToolUse[0].hooks[0].command;
  args[si + 1] = "<json>";
}
const ri = args.indexOf("--resume");
const resumed = ri >= 0 ? args[ri + 1] : null;
const sessionId = resumed && !args.includes("--fork-session") ? resumed : crypto.randomUUID();
const cwd = process.cwd();

const cc = process.env.CLAUDE_CONFIG_DIR;
const regFile = cc ? path.join(cc, "sessions", `${process.pid}.json`) : null;
if (regFile) {
  fs.mkdirSync(path.dirname(regFile), { recursive: true });
  fs.writeFileSync(regFile, JSON.stringify({ pid: process.pid, sessionId, cwd, status: "idle" }));
  const cleanup = () => {
    try {
      fs.unlinkSync(regFile);
    } catch {}
  };
  process.on("exit", cleanup);
  process.on("SIGTERM", () => process.exit(143));
  process.on("SIGHUP", () => process.exit(129));
  const prompt = process.env.FAKE_CLAUDE_PROMPT;
  if (prompt && !resumed) {
    const dir = path.join(cc, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, `${sessionId}.jsonl`),
      JSON.stringify({ type: "user", isSidechain: false, cwd, sessionId, message: { role: "user", content: prompt } }) + "\n",
    );
  }
}

console.log("FAKE-CLAUDE args=" + JSON.stringify(args));
console.log(`SOCK=${process.env.CSUPER_SESSION_SOCK ? "set" : "unset"} SESSION=${process.env.CSUPER_SESSION}`);
console.log(`CWD=${cwd} CONVERSATION=${sessionId} CHILD=${process.env.CLAUDE_CODE_CHILD_SESSION ?? "unset"} CLAUDECODE=${process.env.CLAUDECODE ?? "unset"}`);
console.log("READY");

function hook(payload) {
  const r = spawnSync("/bin/sh", ["-c", hookCmd], { input: JSON.stringify({ session_id: "fake", ...payload }), encoding: "utf8" });
  console.log(`HOOK-SENT ${payload.tool_name ?? payload.hook_event_name} exit=${r.status}${r.stdout || r.stderr ? " out=" + JSON.stringify(r.stdout + r.stderr) : ""}`);
}

let model = "claude-opus-5-5";
let ignoreClear = false;
let limitedResumes = 0;
let lastLimit = "You've hit your 5-hour limit · resets 11pm";
const BANNER = (t) => `\x1b[2K\x1b[1G  \x1b[2m⎿\x1b[22m  \x1b[31m${t}\x1b[39m`;
function limit(text) {
  lastLimit = text;
  console.log(BANNER(text));
  hook({ hook_event_name: "StopFailure", error: "rate_limit", error_details: '429 {"type":"error","error":{"type":"rate_limit_error"}}', last_assistant_message: text });
}
function stop(text) {
  console.log("⏺ " + text.split("\n")[0]);
  hook({ hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: text });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const cmd = line.trim();
  if (cmd === "fail") hook({ hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "false" }, error: "boom" });
  else if (cmd === "ok") hook({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "true" }, tool_response: { stdout: "" } });
  else if (cmd === "edit") hook({ hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: path.join(process.cwd(), "src", "a.ts") }, tool_response: {} });
  else if (cmd === "size") console.log(`SIZE=${process.stdout.columns}x${process.stdout.rows}`);
  else if (/^quit \d+$/.test(cmd)) process.exit(Number(cmd.split(" ")[1]));
  else if (cmd === "done") stop("Wired the session registry.\nAll tests pass.\n::DONE::");
  else if (cmd.startsWith("limit ")) limit(cmd.slice(6));
  else if (cmd === "noclear") console.log(`NOCLEAR=${(ignoreClear = !ignoreClear)}`);
  else if (/^limited-resumes \d+$/.test(cmd)) limitedResumes = Number(cmd.split(" ")[1]);
  else if (cmd === "/clear") {
    console.log(`GOT /clear${ignoreClear ? " (ignored)" : ""}`);
    if (!ignoreClear) hook({ hook_event_name: "SessionStart", source: "clear", model });
  } else if (cmd.startsWith("/model ")) {
    const m = cmd.slice(7).trim();
    const from = model;
    model = `claude-${m}-5-5`;
    console.log(`GOT /model ${m}\n  ⎿  Set model to ${m[0].toUpperCase()}${m.slice(1)} 5.5`);
    hook({ hook_event_name: "PostModelSwitch", from_model: from, to_model: model, requested_model: m, source: "command" });
  } else if (cmd === "/next") {
    console.log("GOT /next");
    hook({ hook_event_name: "UserPromptExpansion", expansion_type: "slash_command", command_name: "next", command_args: "", command_source: "project", prompt: "/next" });
    hook({ hook_event_name: "UserPromptSubmit", prompt: "/next" });
    setTimeout(() => stop("Starting Phase 2: Wiring. Reading the handover first."), 300);
  } else if (cmd === "continue") {
    console.log("GOT continue");
    hook({ hook_event_name: "UserPromptSubmit", prompt: "continue" });
    if (limitedResumes > 0) {
      limitedResumes--;
      setTimeout(() => limit(lastLimit), 200);
    } else setTimeout(() => stop("Continuing where I left off."), 300);
  }
  else console.log("ECHO:" + JSON.stringify(cmd));
});
