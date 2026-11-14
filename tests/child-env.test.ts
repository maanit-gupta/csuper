import { describe, expect, it } from "vitest";
import { claudeChildEnv, SESSION_MARKER_VARS } from "../src/supervisor/child-env.js";

const session = { id: "a1b2c3", sockPath: "/tmp/x/a1b2c3.sock" };

describe("claude child environment", () => {
  // What a shell inside a Claude Code session (here: one already under csuper) looks like.
  const inherited = {
    CLAUDECODE: "1",
    CLAUDE_PID: "36764",
    CLAUDE_CODE_SESSION_ID: "5700c362-2b2e-4439-8218-0bb7c250325b",
    CLAUDE_CODE_CHILD_SESSION: "1",
    CLAUDE_CODE_SESSION_ATTENDED: "1",
    CLAUDE_CODE_ENTRYPOINT: "cli",
    CLAUDE_CODE_EXECPATH: "/x/claude",
    CLAUDE_CODE_SSE_PORT: "64309",
    CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/cc-socks/1.sock",
    CLAUDE_CODE_MESSAGING_TOKEN: "secret",
    AI_AGENT: "claude-code_2-1-325_agent",
    CLAUDE_EFFORT: "medium",
    TRACEPARENT: "00-abc-def-01",
    CSUPER_SESSION: "602645",
    CSUPER_SESSION_SOCK: "/old.sock",
  };
  // User configuration and auth that must survive.
  const userConfig = {
    PATH: "/usr/bin",
    HOME: "/Users/u",
    CLAUDE_CONFIG_DIR: "/Users/u/.claude-work",
    ANTHROPIC_API_KEY: "sk-test",
    ANTHROPIC_BASE_URL: "https://proxy.example",
    ANTHROPIC_MODEL: "claude-haiku-5-5",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth",
    CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDE_CODE_USE_VERTEX: "1",
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: "8000",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    HTTPS_PROXY: "http://p:8080",
    HTTP_PROXY: "http://p:8080",
    NO_PROXY: "localhost",
    https_proxy: "http://p:8080",
    TERM: "xterm-256color",
  };

  it("strips every session marker and keeps user config and auth", () => {
    const out = claudeChildEnv({ ...inherited, ...userConfig }, session);
    for (const k of Object.keys(inherited)) if (!k.startsWith("CSUPER_")) expect(out, k).not.toHaveProperty(k);
    for (const [k, v] of Object.entries(userConfig)) expect(out[k], k).toBe(v);
  });

  it("sets this session's own socket and ID", () => {
    const out = claudeChildEnv(inherited, session);
    expect(out.CSUPER_SESSION).toBe("a1b2c3");
    expect(out.CSUPER_SESSION_SOCK).toBe("/tmp/x/a1b2c3.sock");
  });

  it("is an explicit list, not a CLAUDE* wildcard", () => {
    for (const v of SESSION_MARKER_VARS) expect(v).not.toMatch(/\*/);
    expect(SESSION_MARKER_VARS).not.toContain("CLAUDE_CONFIG_DIR");
    expect(SESSION_MARKER_VARS.some((v) => v.startsWith("ANTHROPIC_"))).toBe(false);
  });

  it("does not mutate its input", () => {
    const env = { ...inherited };
    claudeChildEnv(env, session);
    expect(env.CLAUDECODE).toBe("1");
  });
});
