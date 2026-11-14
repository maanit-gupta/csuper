#!/usr/bin/env node
// csuper hook: forwards Claude Code hook events (tool results, Stop, StopFailure,
// SessionStart, UserPromptSubmit/Expansion, Notification, PostModelSwitch) to the
// supervisor that launched claude.
// Zero dependencies. Fire-and-forget: it never blocks claude, never prints, and always
// exits 0 — including when claude runs outside csuper (CSUPER_SESSION_SOCK unset).
//
// The supervisor registers it for its own claude child via `claude --settings`; you
// don't need to add it to .claude/settings.json yourself.
import net from "node:net";

const sock = process.env.CSUPER_SESSION_SOCK;
const done = () => process.exit(0);
if (!sock) done();
setTimeout(done, 1500).unref(); // hard cap: never hold claude up

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  if (input.length < 1_000_000) input += d;
});
process.stdin.on("error", done);
process.stdin.on("end", () => {
  let h = {};
  try {
    h = JSON.parse(input);
  } catch {
    /* send what we can */
  }
  const event = h.hook_event_name ?? process.argv[2] ?? "unknown";
  const resp = h.tool_response;
  const failed =
    event === "PostToolUseFailure" ||
    (resp && typeof resp === "object" && (resp.is_error === true || resp.success === false || resp.interrupted === true));
  const ti = h.tool_input && typeof h.tool_input === "object" ? h.tool_input : {};
  const str = (v, n) => (typeof v === "string" ? (v.length > n ? v.slice(0, n) : v) : null);
  // Keep the start (phase names) and the end (trigger keyword) of long final messages.
  const tailHead = (v) => (typeof v === "string" && v.length > 8000 ? v.slice(0, 3000) + "\n…\n" + v.slice(-5000) : str(v, 8000));
  const model = typeof h.model === "string" ? h.model : h.model && typeof h.model === "object" ? (h.model.id ?? h.model.display_name ?? null) : null;
  const msg = {
    type: "hook",
    v: 1,
    event,
    tool: typeof h.tool_name === "string" ? h.tool_name : null,
    ok: !failed,
    file: typeof ti.file_path === "string" ? ti.file_path : typeof ti.notebook_path === "string" ? ti.notebook_path : null,
    error: failed ? String(h.error ?? resp?.error ?? "").slice(0, 300) || null : null,
    claude_session_id: typeof h.session_id === "string" ? h.session_id : null,
    source: str(h.source, 40),
    model: str(model, 120),
    prompt: str(h.prompt, 500),
    command_name: str(h.command_name, 120),
    last_assistant_message: tailHead(h.last_assistant_message),
    stop_error: event === "StopFailure" ? str(h.error, 80) : null,
    error_details: str(h.error_details, 2000),
    notification_type: str(h.notification_type, 80),
    message: str(h.message, 1000),
    from_model: str(h.from_model, 120),
    to_model: str(h.to_model, 120),
  };
  const c = net.createConnection(sock, () => c.end(JSON.stringify(msg) + "\n"));
  c.on("close", done);
  c.on("error", done);
});
