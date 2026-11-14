/**
 * Environment for the `claude` that csuper launches.
 *
 * When csuper itself is started from inside a Claude Code session (`! csuper`, a Bash
 * tool call, a hook…), it inherits markers that Claude Code sets on its *children*.
 * Passed on, they make the new `claude` think it's a child session. It then prints
 * "Transcript saving is off", doesn't register in ~/.claude/sessions, and talks to
 * the parent's IDE and messaging sockets.
 *
 * Only these markers are removed, by exact name. User configuration and auth are
 * never touched: CLAUDE_CONFIG_DIR, ANTHROPIC_*, CLAUDE_CODE_USE_BEDROCK/VERTEX,
 * CLAUDE_CODE_OAUTH_TOKEN, proxy variables, etc. That's why this is an explicit list
 * and not a CLAUDE* / CLAUDE_CODE_* wildcard.
 *
 * Source: Claude Code 2.1.325 builds child env as {CLAUDECODE, CLAUDE_CODE_SESSION_ID,
 * CLAUDE_CODE_CHILD_SESSION, CLAUDE_CODE_SESSION_ATTENDED, CLAUDE_PID, AI_AGENT?,
 * CLAUDE_EFFORT?, TRACEPARENT?}; the rest point at the parent process.
 */
export const SESSION_MARKER_VARS = [
  // Set by Claude Code on every child process.
  "CLAUDECODE",
  "CLAUDE_PID",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "AI_AGENT", // "claude-code_<ver>_agent": marks the caller as an agent, not a person
  "CLAUDE_EFFORT", // the parent's per-turn effort level
  "TRACEPARENT", // the parent's telemetry span
  // The parent session's own process, IDE link and messaging socket.
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  // An outer csuper's session (replaced below with this session's own).
  "CSUPER_SESSION",
  "CSUPER_SESSION_SOCK",
] as const;

/** Copy of `env` without session markers, plus this csuper session's socket and ID. */
export function claudeChildEnv(env: NodeJS.ProcessEnv, session: { id: string; sockPath: string }): Record<string, string> {
  const out: Record<string, string> = {};
  const drop = new Set<string>(SESSION_MARKER_VARS);
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || drop.has(k)) continue;
    out[k] = v;
  }
  out.CSUPER_SESSION_SOCK = session.sockPath;
  out.CSUPER_SESSION = session.id;
  return out;
}
