import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findClaudeSession,
  listClaudeSessions,
  projectSlug,
  promptText,
  summarizeTranscript,
} from "../src/supervisor/claude-sessions.js";
import { buildClaudeArgs, ensureSpawnHelper, hookSettings, modelFromArgs } from "../src/supervisor/supervisor.js";

const A = "aaaaaaaa-1111-4111-8111-111111111111";
const B = "bbbbbbbb-2222-4222-8222-222222222222";
const user = (content: unknown, extra: object = {}) => JSON.stringify({ type: "user", cwd: "/w/p", message: { role: "user", content }, ...extra });

describe("Claude Code transcripts", () => {
  it("slugs a cwd like Claude Code does", () => {
    expect(projectSlug("/Users/me/My Project.v2")).toBe("-Users-me-My-Project-v2");
  });

  it("turns raw user content into one readable line", () => {
    expect(promptText("fix\n  the   bug")).toBe("fix the bug");
    expect(promptText("<command-name>/run</command-name><command-args> fast </command-args>")).toBe("/run fast");
    expect(promptText([{ type: "tool_result", content: "x" }])).toBe("");
    expect(promptText([{ type: "text", text: "hello" }, { type: "image" }])).toBe("hello");
    expect(promptText("<local-command-stdout>ok</local-command-stdout>")).toBe("");
    expect(promptText('<pasted_content id="1">two things</pasted_content>')).toBe("two things");
  });

  it("prefers the first typed prompt over slash commands and skips sidechains", () => {
    const head = [
      "not json",
      JSON.stringify({ type: "mode" }),
      user("<command-name>/model</command-name>"),
      user("subagent prompt", { isSidechain: true }),
      user("real question", { gitBranch: "main" }),
      '{"partial":',
    ].join("\n");
    expect(summarizeTranscript(head)).toEqual({ cwd: "/w/p", firstPrompt: "real question", title: null, gitBranch: "main" });
    expect(summarizeTranscript(user("<command-name>/clear</command-name>")).firstPrompt).toBe("/clear");
  });

  describe("listing", () => {
    let root: string;
    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-"));
    });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    it("lists newest first, skips empty/non-uuid files, marks live ones", () => {
      const proj = path.join(root, "projects", projectSlug("/w/p"));
      fs.mkdirSync(proj, { recursive: true });
      fs.mkdirSync(path.join(root, "sessions"));
      fs.writeFileSync(path.join(proj, `${A}.jsonl`), user("older") + "\n");
      fs.writeFileSync(path.join(proj, `${B}.jsonl`), user("newer") + "\n");
      fs.writeFileSync(path.join(proj, "cccccccc-3333-4333-8333-333333333333.jsonl"), JSON.stringify({ type: "mode" }) + "\n");
      fs.writeFileSync(path.join(proj, "notes.jsonl"), user("x") + "\n");
      fs.utimesSync(path.join(proj, `${A}.jsonl`), new Date(Date.now() - 60e3), new Date(Date.now() - 60e3));
      fs.writeFileSync(path.join(root, "sessions", "1.json"), JSON.stringify({ pid: process.pid, sessionId: A }));
      fs.writeFileSync(path.join(root, "sessions", "2.json"), JSON.stringify({ pid: 999999, sessionId: B })); // dead

      const list = listClaudeSessions("/w/p", { projectsRoot: path.join(root, "projects"), sessionsDir: path.join(root, "sessions") });
      expect(list.map((s) => [s.id, s.firstPrompt, s.livePid])).toEqual([
        [B, "newer", null],
        [A, "older", process.pid],
      ]);
      expect(findClaudeSession(list, "bbbb")).toMatchObject({ id: B });
      expect(findClaudeSession(list, "")).toBe("ambiguous");
      expect(findClaudeSession(list, "ffff")).toBeNull();
      expect(listClaudeSessions("/never/here", { projectsRoot: path.join(root, "projects") })).toEqual([]);
    });
  });
});

describe("supervisor helpers", () => {
  it("puts resume flags and hook settings before the user's claude args", () => {
    expect(buildClaudeArgs({ claudeArgs: ["--model", "opus"], resumeId: A, fork: true, settings: "{}" })).toEqual([
      "--resume", A, "--fork-session", "--settings", "{}", "--model", "opus",
    ]);
    expect(buildClaudeArgs({ claudeArgs: [], settings: "{}", fork: true })).toEqual(["--settings", "{}"]);
    // A user's own --settings wins; we don't pass a second one.
    expect(buildClaudeArgs({ claudeArgs: ["--settings=x.json"], settings: "{}" })).toEqual(["--settings=x.json"]);
  });

  it("registers the hook for tool results and the autopilot's lifecycle events, with quoted paths", () => {
    const s = JSON.parse(hookSettings("/n/node", "/a b/hook.js"));
    expect(Object.keys(s.hooks)).toEqual([
      "PostToolUse",
      "PostToolUseFailure",
      "Stop",
      "StopFailure",
      "SessionStart",
      "UserPromptSubmit",
      "UserPromptExpansion",
      "Notification",
      "PostModelSwitch",
    ]);
    expect(s.hooks.PostToolUse[0]).toMatchObject({ matcher: "*" });
    expect(s.hooks.Stop[0].matcher).toBeUndefined(); // every source / error kind
    for (const e of Object.keys(s.hooks)) expect(s.hooks[e][0].hooks[0].command).toBe('"/n/node" "/a b/hook.js"');
  });

  it("reads --model in both forms", () => {
    expect(modelFromArgs(["--model", "sonnet"])).toBe("sonnet");
    expect(modelFromArgs(["--model=opus"])).toBe("opus");
    expect(modelFromArgs(["-p", "hi"])).toBeNull();
  });

  it("makes node-pty's spawn-helper executable", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pty-"));
    const p = path.join(dir, "prebuilds", `${process.platform}-${process.arch}`);
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, "spawn-helper"), "", { mode: 0o644 });
    ensureSpawnHelper(dir);
    expect(fs.statSync(path.join(p, "spawn-helper")).mode & 0o777).toBe(0o755);
    fs.rmSync(dir, { recursive: true });
  });
});
