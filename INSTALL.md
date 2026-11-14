# Installing csuper

> **Current state:** the supervisor runs `claude`, publishes the session to the dashboard and supports pause/resume. Through Claude Code hooks it runs the autopilot: keyword triggers, checked `/clear` → `/next` cycles, automatic resume after usage limits with Opus → Sonnet failover, and git checkpoints. It also reports tool failures and edit thrash. The hooks it relies on (Stop, StopFailure, SessionStart, UserPromptSubmit/Expansion, PostModelSwitch) were checked against Claude Code 2.1.325.

## Requirements

| | Check | Notes |
|---|---|---|
| macOS 13+ on Apple Silicon | `uname -m` → `arm64` | `package.json` declares `os: darwin`, `cpu: arm64` |
| Node.js ≥ 20 | `node -v` | Any install works: nvm, Homebrew or nodejs.org. With nvm, see [the nvm note](#command-not-found-csuper) |
| Claude Code | `claude --version` | csuper runs the `claude` on your PATH (or `CSUPER_CLAUDE_BIN`) |
| Xcode Command Line Tools | `xcode-select -p` prints a path | Only if `node-pty` has to compile from source (a prebuilt binary for Apple Silicon ships with it). Install with `xcode-select --install` (no sudo) |
| Python 3 | `python3 --version` | Only for `npm run test:e2e` |

The only runtime dependency is `node-pty` (native, for the supervisor). Ink, React, zod and yaml are bundled into `dist/` at build time.

## Install from source

```bash
git clone https://github.com/maanit-gupta/csuper.git && cd csuper
npm install && npm run build && npm link
```

`npm link` puts a `csuper` command on your PATH. It is a symlink to this checkout's `dist/csuper.js`, so after you pull changes, `npm run build` is enough. You don't need to link again.

Check it from any directory:

```bash
cd ~ && which csuper && csuper --version    # → csuper 0.1.0
csuper sessions                             # → "no csuper sessions" (exit 0)
```

> **npm 11 and install scripts:** `npm install` may print `npm warn allow-scripts ... esbuild ... fsevents`. That's harmless: esbuild ships its binary as a separate package, and `node-pty` is already approved in `package.json` (`allowScripts`). csuper also fixes node-pty's `spawn-helper` permissions itself at startup, which is the usual cause of `posix_spawnp failed`.

## Claude Code hooks

There's nothing to register. When csuper starts `claude` it passes its hook with `claude --settings '{"hooks":…}'`, which Claude Code merges with your own settings for that run only. Your `.claude/settings.json` files aren't touched, and a `claude` started without csuper doesn't run the hook.

The hook is `dist/hooks/csuper-hook.js` (zero dependencies). It handles `PostToolUse` and `PostToolUseFailure`, sends one line to the session socket in `CSUPER_SESSION_SOCK`, and always exits `0` within 1.5 s, so it can never block Claude. If you pass your own `--settings` to `csuper`, csuper leaves it alone and skips its hook (the dashboard then shows no tool data).

If you'd rather register it yourself (for example to keep it in a project's settings), use:

```json
{
  "hooks": {
    "PostToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node /path/to/csuper/dist/hooks/csuper-hook.js" }] }],
    "PostToolUseFailure": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node /path/to/csuper/dist/hooks/csuper-hook.js" }] }]
  }
}
```

Outside csuper `CSUPER_SESSION_SOCK` is unset and the hook does nothing.

## Quick start

Terminal 1 runs the session:

```bash
csuper [claude-args]   # a new claude under csuper; args go to claude (--model, -c, …)
csuper adopt           # or continue an existing conversation under csuper (see below)
```

Inside it, Claude looks and behaves exactly as usual, except that **Ctrl+G toggles csuper's autopilot** instead of opening Claude's external editor. When claude exits, csuper exits with the same code.

Terminal 2 runs the dashboard:

```bash
csuper dash                     # with several sessions, shows a picker
csuper dash --session a1b2c3    # pin to one session
```

Press `?` in the dashboard for keys: `p` pause/resume, `c` cancel countdown, `w` skip a rate-limit wait, `s` switch session, `l` full-screen log, `q` quit. Panel 3 **Cycles** shows completed/max, failures, the live step ("4/8 waiting for clear confirmation · times out in 18s"), and the last 10 cycles with duration, result and the phase `/next` started. The status bar always shows `cycles N/max`. Panel 2 shows any rate-limit wait: the reason, reset time, resume countdown, resume attempts, total time waited this session, and failovers.

The autopilot's settings (`triggers`, `pre_clear_delay_ms`, `autopilot`, `rate_limits`) are in `csuper.config.yaml`. The built-in defaults are the same, so a project without a config file behaves identically.

### Adopting existing sessions

`csuper adopt` turns ordinary Claude Code conversations, whether running now or ended earlier, into csuper sessions without losing the conversation. Each one gets its own socket, log and registry entry, and shows up in `csuper dash` with **"adopted from <id>"**.

**What it does.** A running `claude` can't be moved into another process, so adopting means: find the conversation → make sure no `claude` has it open → run `claude --resume <id>` under csuper, in the conversation's own folder. The conversation keeps its ID and its full history. Claude Code's transcripts in `~/.claude` are only ever read, never edited, moved or deleted.

**Why the original has to exit.** Claude Code doesn't stop two processes from opening the same conversation; both would append to the same transcript and corrupt it. So csuper refuses a conversation that's still open, unless you pass `--stop-original` (or `--fork` to continue a copy under a new ID). It checks when you pick, and again right before launching.

```bash
csuper adopt                      # picker: every project, newest first; Space selects several, Enter adopts
csuper adopt 1073635c             # one conversation, by ID or unique prefix (any project)
csuper adopt --latest             # the most recent conversation for this folder
csuper adopt --all-live           # every conversation that's open in claude right now
csuper adopt 1073635c --dry-run   # show what would happen; change nothing
```

| Flag | Effect |
|---|---|
| `--stop-original` | If the original `claude` is still running, list its PID and project and ask **y/N**, then send it SIGTERM and wait until it has exited, left `~/.claude/sessions`, and its transcript has been unchanged for 1 s. If that takes longer than `adopt.stop_wait_timeout_ms` (10 s), csuper reports it and gives up. It never sends SIGKILL. Without this flag a live conversation is refused, with instructions. |
| `--fork` | Continue in a new conversation ID; the original can stay open. |
| `--compact` | Send `/compact` once the resumed claude is ready, so a long conversation doesn't bring its full token cost into the autopilot loop. |
| `--autopilot` / `--paused` | Autopilot **starts paused** by default (`adopt.default_autopilot: false`), so nothing in the resumed conversation can set off a chain before you've looked at it. Start it with Ctrl+G, or `p` in the dashboard. |
| `--here` | Open in this terminal (one conversation only). |
| `--tabs` | A new tab per conversation in the terminal you're using: Terminal.app or iTerm2 (via `osascript`). This is the default when several are selected. Any other terminal gets an error suggesting `--here`. Terminal.app opens tabs with ⌘T through System Events, which needs your terminal allowed under *System Settings → Privacy & Security → Accessibility*; without that it opens a new window instead. |
| `-- <args>` | Passed on to `claude`, e.g. `-- --model opus`. |

With one conversation and no `--here`/`--tabs`, `adopt.default_open_mode` decides (`tabs`; falls back to `here` in a terminal that can't open tabs). A conversation is never stopped without y/N, not even with `--all-live`, which asks once for all of them. csuper never signals itself, the `claude` you ran it from (or any other ancestor), or a `claude` that's already supervised by csuper.

At the end you get a summary: conversation, project, csuper session ID, and result (adopted / skipped / refused / failed, with the reason). If one conversation fails, the others go ahead. Every step is logged to `~/.csuper/logs/adopt.jsonl` (`adopt.scan`, `adopt.selected`, `adopt.stop_original`, `adopt.failed`), and `adopt.resumed` goes to the new session's own log.

The picker's status column: `live` (open in a claude listed in `~/.claude/sessions`), `possibly live` (a `claude` is running in that folder but isn't in that registry, so csuper can't tell which conversation it has open), `ended`, and `already csuper`. The `~/.claude/sessions` registry is undocumented Claude Code internals; if it's missing, csuper falls back to `ps` + `lsof`.

**`csuper resume`** is the same command as `csuper adopt <id> --here`, limited to the current folder, and keeps its flags:

```bash
csuper resume                    # picker for this folder
csuper resume 1073635c           # by ID or unique prefix
csuper resume --list             # print this folder's conversations
csuper resume 1073635c --fork    # continue a copy now, leaving the original open
csuper resume 1073635c -- --model opus
```

Like `adopt`, it starts with autopilot paused unless you pass `--autopilot`.

**Going back to plain Claude Code.** Nothing about the conversation changes, so quit the csuper session (`/exit`) and run `claude --resume <id>` in the same folder. The csuper session's socket and registry entry go away when it exits.

One-shot commands for scripts:

```bash
csuper sessions [--json] [--prune]
csuper status   [--session <id>] [--json]     # exit 0 ok · 1 paused/waiting · 2 not found/ambiguous · 3 anomaly/breaker/cycle failed/gave up on a limit · 4 stale
csuper logs     [--session <id>] [-f] [--level warn] [--event anomaly.detected] [--since 2h] [-n 200] [--raw]
csuper ctl      [--session <id>] pause|resume|cancel-countdown|skip-wait [--yes]
```

`--session` can be left out when exactly one live session exists. `CSUPER_SESSION=<id>` sets a default.

## Where things live

Everything is under `~/.csuper`, or under `$CSUPER_HOME` if that is set:

```text
~/.csuper/
├── csuper.config.yaml     # optional global config
├── sessions/<id>.sock     # one Unix socket per live session (mode 0600, dir 0700)
├── sessions/<id>.json     # {id, pid, claude_pid, cwd, started_at, config_path, version, claude_session_id, adoptedFrom}
├── logs/<id>.jsonl        # per-session log; rotated to <id>.1.jsonl … ; dash.jsonl = dashboard's own errors; adopt.jsonl = csuper adopt
└── logs/ratelimit-samples.jsonl   # every raw usage-limit message seen (hook or screen), with how it was parsed
```

Config is read from the first of these that exists: `$CSUPER_CONFIG`, `./csuper.config.yaml` in the current directory, then `~/.csuper/csuper.config.yaml`. The repo's `csuper.config.yaml` lists every key with its default.

## Uninstall

```bash
npm unlink -g csuper    # removes the global command
rm -rf ~/.csuper        # sockets, session registry, logs, global config
```

After that, delete the checkout as well.

## Troubleshooting

### `node-pty` fails to load or `posix_spawnp failed`
- csuper makes node-pty's `spawn-helper` executable on startup. If that fails (e.g. a read-only install), run `chmod +x node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper`.
- Error mentions `xcrun`, `gyp`, `make` or `clang`: run `xcode-select -p`. If that fails, run `xcode-select --install`. If it points at an Xcode that was moved or deleted, open Xcode once to finish setup, or ask an admin to run `xcode-select --switch` (this needs sudo).
- `npm warn allow-scripts ... node-pty`: npm skipped the compile step. Run `npm approve-scripts node-pty && npm rebuild node-pty`.
- Changed Node versions? Native modules are built per Node ABI, so run `npm rebuild` in the checkout.

### `command not found: csuper`
- Find the global bin directory with `npm prefix -g`, then check that `<that>/bin` is on your `PATH` (`echo $PATH`).
- **nvm:** `npm link` puts the symlink inside the active Node version (`~/.nvm/versions/node/vX/bin/csuper`). After `nvm use <other>`, or in a shell whose nvm default differs, `csuper` is gone. Either run `npm link` again under that version, or make it the default: `nvm alias default <version>`.
- After a fresh `npm link`, run `hash -r` (bash) or `rehash` (zsh), or open a new terminal.

### `` `claude` not found on PATH ``
csuper runs the `claude` on your PATH. Set `CSUPER_CLAUDE_BIN=/path/to/claude` if it lives elsewhere.

### `csuper resume` finds no conversations
Run it from the folder where you started claude: conversations are stored per folder. Conversations with no prompt at all (opened and closed) aren't listed. `csuper adopt` searches every project.

### "Transcript saving is off" when starting csuper from inside Claude Code
Claude Code sets markers such as `CLAUDECODE` and `CLAUDE_CODE_CHILD_SESSION` on everything it runs (`! csuper`, Bash tool calls). If they reach a new `claude`, it treats itself as a child session: it stops saving the transcript and doesn't appear in `~/.claude/sessions`. csuper removes exactly those markers (listed in `src/supervisor/child-env.ts`) before starting `claude`. Your configuration and auth (`CLAUDE_CONFIG_DIR`, `ANTHROPIC_*`, `CLAUDE_CODE_USE_BEDROCK`, proxy variables, …) are passed through unchanged.

### `adopt --stop-original` timed out
The original `claude` didn't exit within `adopt.stop_wait_timeout_ms`, or kept writing its transcript. csuper doesn't escalate to SIGKILL. Quit it yourself (`/exit` in its terminal) and run `csuper adopt` again.

### Stale sessions
A session whose daemon died without cleaning up still has its `.sock` and `.json` files. `csuper sessions` shows it as `stale`, and `csuper status` exits `4`. Remove it with:

```bash
csuper sessions --prune
```

### Dashboard says `DISCONNECTED`
The daemon stopped responding, or it restarted. The dashboard keeps showing the last known state and retries with backoff up to 10 s (`general.reconnect_max_backoff_ms`). It picks up a fresh snapshot as soon as the socket is back.

### `socket path too long for macOS`
macOS limits socket paths to 104 bytes. Use a shorter `CSUPER_HOME`.

## Development

```bash
npm test             # unit + TUI snapshot tests (vitest)
npm run typecheck
npm run test:e2e     # drives the built CLI in a real pty: dashboard keys, reconnect, switching, status codes, supervisor, resume, adopt
CSUPER_E2E_REAL=1 npm run test:e2e -- real   # opt-in: one smoke test with the real claude on haiku (a few cents)
```

`test:e2e` creates `.cache/e2e-venv` with `pyte` the first time it runs. It works in a throwaway `CSUPER_HOME` and `CLAUDE_CONFIG_DIR`, and the supervisor suites run `tests/e2e/fake-claude.mjs` instead of `claude`, so your real `~/.csuper`, `~/.claude` and Claude account are never touched. The adopt suite opens "tabs" through `tests/e2e/fake-tab.py` (`CSUPER_TAB_LAUNCHER`), and sets `CSUPER_CLAUDE_SCAN=off` so the real claudes on your machine aren't mistaken for unregistered ones. The opt-in `real` suite is the exception: it uses your real `claude` and `~/.claude` (in `/tmp/csuper-e2e-real`) and leaves its small transcripts there. `npm run demo` starts a simulated session for trying the dashboard without claude. Set `CSUPER_E2E_BIN=$(which csuper)` to test the linked command instead of `dist/`.
