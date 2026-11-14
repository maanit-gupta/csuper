# CLAUDE.md — `csuper dash`: Terminal Status Dashboard for csuper

> Companion spec to the main csuper `CLAUDE.md`. Everything here ships **inside csuper** as subcommands. It adds no separate app, no GUI, and no extra system software.

---

## 1. Overview

`csuper dash` is a terminal-only dashboard for watching and lightly steering running csuper supervisor sessions. It runs in a **separate terminal tab or split** next to the `claude` session that csuper is driving, so it never touches that session's PTY.

It has two modes:

- **Interactive TUI** (`csuper dash`): a full-screen, live-updating, keyboard-driven view in the style of htop or lazygit.
- **One-shot subcommands** (`csuper status`, `csuper logs`, `csuper sessions`, `csuper ctl`): these print and exit, so they can be scripted and piped into `jq` or `grep`.

**Design principles**
- **Terminal only.** No GUI, no browser, no Electron, no menu-bar app.
- **Nothing extra to install.** It ships in the csuper package, so removing csuper removes the dashboard.
- **Push, not poll.** Live data streams over each session's Unix socket.
- **Safe by default.** It can only pause or resume autopilot, cancel a pending `/clear` countdown, and skip a rate-limit wait. It cannot run arbitrary commands.
- **Target:** macOS on Apple Silicon only.

---

## 2. Features

### 2.1 Panels (TUI)
| Panel | Contents |
|---|---|
| **Session & Autopilot** | Session ID, project directory, autopilot ON/OFF/PAUSED, active model (opus/sonnet), auto-cycles used vs `max_auto_cycles_per_session`, inside/outside `active_hours`, uptime, `claude` child PID |
| **Rate Limits & Quota** | State (`ok` / `waiting` / `failover`), 5-hour window reset countdown, weekly reset countdown, weekly quota % vs `weekly_quota_stop_pct` (as a bar), whether `caffeinate` is active (and its PID), scheduled resume time including `reset_margin_seconds` |
| **Triggers & Anomalies** | Last N keyword hits (trigger name, keyword, time), commands injected, live `/clear` countdown, consecutive tool-failure streak vs threshold, edit-thrash counter, protected-path violations, last anomaly and the recovery commands it ran |
| **Git & Handover** | Last `chore(csuper): checkpoint` commit (short SHA, time, files changed), `csuper-anomaly-recovery` stashes, scrollable preview of `.claude/handover.md` with its last-modified time |
| **Log Stream** | Live tail of the session's JSONL log, pretty-printed and colored by level, filterable by level, event, and text |

### 2.2 Multi-session
- Lists every live csuper session; you can switch with a key or start pinned with `--session <id>`.
- Detects stale sessions (the socket exists but nothing answers) and marks them `stale`. `csuper sessions --prune` removes them.

### 2.3 Safe controls
| Action | Effect | Confirmation |
|---|---|---|
| Pause / resume autopilot | Same as pressing `Ctrl+G` in the supervisor terminal | None |
| Cancel pending `/clear` countdown | Stops the `pre_clear_delay_ms` countdown that is running | None |
| Skip rate-limit wait | Sends `resume_prompt` now instead of waiting for the scheduled reset | **Yes** (`y/N`), because it may hit the limit again |

Controls the dashboard deliberately leaves out: manually firing triggers, resetting cycle counters, editing config, and sending free-text input to the PTY.

---

## 3. Installation

The dashboard is part of csuper, so installing csuper installs it.

```bash
# Single command
npm install -g [FILL: published package name, e.g. csuper]

# Or from source
git clone [FILL: repo URL] && cd csuper && npm install && npm run build && npm link
```

**Requirements**
- macOS 13+ on Apple Silicon `[FILL: confirm minimum macOS version]`
- Node.js ≥ 20, which csuper already requires
- Xcode Command Line Tools, already needed by csuper's `node-pty` native build. The dashboard adds no native modules.

**Dependency policy**
- The TUI uses **Ink** (React for CLIs). Ink, React, and any helpers are **bundled at build time with esbuild** into `dist/dash.js`. They are dev-dependencies only, so the dashboard adds nothing to the runtime install.
- `hooks/*.js` stay zero-dependency, as the main spec requires.

**Uninstall** (leaves nothing behind)
```bash
npm rm -g [FILL: package name]
rm -rf ~/.csuper        # sockets, session registry, logs
```

---

## 4. Usage

### 4.1 Launch
```bash
# Terminal 1: run Claude under the supervisor (unchanged)
csuper [claude-args]

# Terminal 2: open the dashboard
csuper dash                    # with several sessions, shows a picker
csuper dash --session a1b2c3   # pin to one session
```

### 4.2 TUI keybindings
| Key | Action |
|---|---|
| `Tab` / `Shift+Tab` | Move focus between panels |
| `1`–`5` | Jump to a panel |
| `s` | Session switcher |
| `p` | Pause / resume autopilot |
| `c` | Cancel pending `/clear` countdown |
| `w` | Skip rate-limit wait (asks `y/N`) |
| `l` | Expand the log stream to full screen |
| `/` | Filter logs (text) |
| `f` | Cycle the log level filter (`all` → `info+` → `warn+` → `error`) |
| `h` | Toggle the handover.md preview |
| `?` | Help overlay |
| `q` / `Ctrl+C` | Quit the dashboard (the session keeps running) |

> These keys only work in the dashboard's own terminal. They do not clash with `Ctrl+G` or `Space`/`Ctrl+C` in the supervisor terminal, because the two run in separate processes. `[FILL: confirm or change any bindings]`

### 4.3 One-shot subcommands
```bash
csuper sessions [--json] [--prune]
csuper status   [--session <id>] [--json]
csuper logs     [--session <id>] [-f|--follow] [--level info|warn|error]
                [--event <name>] [--since 10m|2h|<ISO>] [-n 200] [--raw]
csuper ctl      [--session <id>] pause|resume|cancel-countdown|skip-wait [--yes]
```

- `--session` can be left out when exactly one live session exists. With several, the command exits with code `2` and lists them.
- `--json` prints the same snapshot object the TUI renders (see §6.3).
- `--raw` prints log lines as stored (JSONL) for piping to `jq`.

**`csuper status` exit codes** (for scripts and shell prompts)
| Code | Meaning |
|---|---|
| `0` | Running, autopilot on, no problems |
| `1` | Autopilot paused, or waiting on a rate limit |
| `2` | Session not found, or ambiguous |
| `3` | Anomaly active, or circuit breaker tripped |
| `4` | Daemon not responding (stale socket) |

---

## 5. Configuration

### 5.1 New `dashboard:` section in `csuper.config.yaml`
`src/config.ts` (zod) must define the same keys, as the main spec requires. Hot-reload applies.

```yaml
dashboard:
  refresh_fallback_ms: 1000        # Redraw interval if no events arrive (keeps countdowns ticking)
  log_tail_lines: 500              # Lines held in the TUI log buffer
  default_log_level: "info"        # all | info | warn | error
  recent_triggers_shown: 10
  handover_preview_lines: 15
  confirm_skip_wait: true          # Ask y/N before skip-wait
  color: "auto"                    # auto | always | never
  time_format: "24h"               # 24h | 12h  [FILL: preference]
```

### 5.2 Required changes to the core csuper spec
Multi-session support and the dashboard change some existing csuper defaults:

```yaml
general:
  csuper_home: "~/.csuper"                   # Root for everything below
  socket_dir: "~/.csuper/sessions"           # REPLACES socket_path; one <id>.sock per session
  log_dir: "~/.csuper/logs"                  # REPLACES log_file; one <id>.jsonl per session
  log_max_bytes: [FILL: e.g. 10485760]       # Rotate threshold per session log
  log_keep_files: [FILL: e.g. 5]
```

- **Session ID:** `[FILL: format, e.g. 6-char random hex or <project-dirname>-<hex>]`.
- **Hooks** find their session through a `CSUPER_SESSION_SOCK` env var that the supervisor sets on the `claude` child. If it is unset, they fall back to doing nothing and exiting `0`.

### 5.3 Environment variables
| Var | Purpose |
|---|---|
| `CSUPER_HOME` | Overrides `~/.csuper` |
| `CSUPER_SESSION` | Default session ID for `dash`, `status`, `logs`, and `ctl` |
| `CSUPER_SESSION_SOCK` | Set by the supervisor for hook scripts (internal) |
| `NO_COLOR` | Turns off color (standard) |

### 5.4 Security
- `~/.csuper` and `~/.csuper/sessions` are created with mode `0700`, and sockets are `chmod 0600`. Owner-only file permissions are the access control. There are no tokens.
- The daemon checks the message `type`/`action` allow-list (§6.2) and rejects anything else.

---

## 6. Architecture & IPC

### 6.1 Session registry
```text
~/.csuper/
├── sessions/
│   ├── <id>.sock          # Unix socket, owned by that session's daemon
│   └── <id>.json          # {id, pid, claude_pid, cwd, started_at, config_path, version}
└── logs/
    ├── <id>.jsonl
    └── dash.jsonl         # The dashboard's own diagnostics
```
The daemon writes `<id>.json` at startup. On clean teardown it deletes both `<id>.sock` and `<id>.json`, extending the main spec's §5.5. A session is **stale** when connecting returns `ECONNREFUSED`/`ENOENT` or when `pid` is no longer alive.

### 6.2 Protocol: newline-delimited JSON over the session socket
```jsonc
// client → daemon
{"type":"subscribe","v":1}
{"type":"control","v":1,"action":"autopilot.pause"|"autopilot.resume"|"countdown.cancel"|"ratelimit.skip_wait"}

// daemon → client
{"type":"snapshot","v":1,"state":{ /* §6.3 */ }}   // sent right after subscribe
{"type":"event","v":1,"event":"trigger.matched","ts":"...","data":{...}}
{"type":"event","v":1,"event":"state.patch","ts":"...","data":{ /* partial state */ }}
{"type":"log","v":1,"line":{ /* JSONL record */ }}
{"type":"ack","v":1,"action":"...","ok":true,"error":null}
```
- Hook scripts keep their existing fire-and-forget messages on the same socket. The daemon tells clients apart by the first message.
- The daemon must never block on a slow dashboard client. Each subscriber gets a bounded buffer `[FILL: e.g. 1000 msgs]`, and the daemon drops the client when it overflows.
- Protocol version `v` lets a dashboard warn when it doesn't match the daemon's version.

### 6.3 State snapshot shape (also the `csuper status --json` output)
```ts
interface DashState {
  session: { id: string; cwd: string; pid: number; claudePid: number; startedAt: string; version: string };
  autopilot: { enabled: boolean; pausedReason: null | "user" | "blocked" | "anomaly" | "breaker" | "hours" };
  model: string;
  cycles: { used: number; max: number };
  activeHours: { window: string; inside: boolean };
  countdown: null | { trigger: string; firesAt: string; commands: string[] };
  rateLimit: {
    status: "ok" | "waiting" | "failover";
    sessionResetAt: string | null;
    weeklyResetAt: string | null;
    weeklyPct: number | null;           // [FILL: source — see Future Considerations]
    resumeAt: string | null;
    caffeinatePid: number | null;
  };
  triggers: { recent: Array<{ name: string; keyword: string; ts: string; commands: string[] }> };
  anomalies: { toolFailureStreak: number; threshold: number; editThrash: Record<string, number>;
               protectedViolations: string[]; last: null | { kind: string; ts: string; actions: string[] } };
  git: { lastCheckpoint: null | { sha: string; ts: string; files: number }; stashes: string[] };
  handover: { path: string; mtime: string | null };
}
```

### 6.4 New and changed files
```text
src/
├── cli/
│   ├── dash.tsx            # Ink root: layout, focus, keybindings
│   ├── panels/             # SessionPanel, RateLimitPanel, TriggersPanel, GitPanel, LogPanel
│   ├── status.ts           # csuper status
│   ├── logs.ts             # csuper logs (reads JSONL files directly; -f uses fs.watch)
│   ├── sessions.ts         # csuper sessions / --prune
│   ├── ctl.ts              # csuper ctl
│   └── client.ts           # Socket client: connect, subscribe, reconnect with backoff
├── session-registry.ts     # Read/write ~/.csuper/sessions/*
├── logger.ts               # JSONL logger + rotation (replaces ad-hoc file logging)
└── ipc-server.ts           # + subscriber fan-out, control allow-list, snapshot builder
tests/
├── ipc-protocol.test.ts
├── session-registry.test.ts
├── status-exit-codes.test.ts
└── log-filter.test.ts
```

---

## 7. Logging

**Location:** `~/.csuper/logs/<session-id>.jsonl` (one per session). The dashboard's own logs go to `~/.csuper/logs/dash.jsonl`.

**Record format** (one JSON object per line):
```json
{"ts":"2026-11-14T07:12:03.481+05:30","level":"info","session":"a1b2c3","event":"trigger.matched","msg":"::DONE:: matched (last_line)","data":{"trigger":"task_complete","commands":["/clear","/next"]}}
```
- `level`: `debug | info | warn | error`
- `event`: dotted names from a fixed list kept in `src/logger.ts`, e.g. `session.start`, `trigger.matched`, `command.injected`, `countdown.started`, `countdown.cancelled`, `anomaly.detected`, `git.checkpoint`, `git.stash`, `ratelimit.detected`, `ratelimit.resume_scheduled`, `ratelimit.resumed`, `model.failover`, `breaker.tripped`, `autopilot.toggled`, `control.received`, `hook.error`
- Timestamps are ISO-8601 with the local offset.
- Rotation: when the size exceeds `log_max_bytes`, rotate to `<id>.1.jsonl` … and keep `log_keep_files`.

**Viewing**
```bash
csuper logs -f                                 # live, pretty
csuper logs --level warn --since 2h            # warnings and errors, last 2 hours
csuper logs --event anomaly.detected --raw | jq .data
```
Inside the TUI, use the Log Stream panel (`l` for full screen, `/` to search, `f` for level).

**Rules carried over from the core spec**
- Nothing in `src/*.ts` writes to stdout/stderr while the PTY supervisor is running. All diagnostics go to the JSONL log.
- The dashboard runs in its **own** terminal, so it may draw to its own stdout. It still routes its internal errors to `dash.jsonl` and not the screen.
- On exit, the dashboard restores the terminal (leaves the alternate screen, shows the cursor, turns off raw mode), including on `SIGINT`/`SIGTERM`/uncaught errors.

---

## 8. Engineering Guardrails (dashboard-specific)

1. **Never the PTY.** The dashboard talks to the daemon only through the socket. It never writes to the `claude` PTY itself; the daemon performs every injected keystroke.
2. **Daemon isolation.** A crashed, frozen, or slow dashboard must have no effect on the supervised session (§6.2 bounded buffers, non-blocking writes).
3. **Reconnect.** If the socket drops, show `DISCONNECTED`, retry with exponential backoff (max `[FILL: e.g. 10s]`), and fetch a fresh snapshot on reconnect.
4. **Countdown accuracy.** Countdowns are computed client-side from absolute `firesAt`/`resetAt` timestamps, never from decrementing counters.
5. **Keep config in sync.** Every `dashboard:` key exists in both `csuper.config.yaml` and the zod schema in `src/config.ts`.
6. **Tests first.** Protocol, registry, exit codes, and log filtering get unit tests (`npm test`). TUI rendering gets snapshot tests with `ink-testing-library`.

---

## 9. Future Considerations

- **Weekly quota % source.** `[FILL: how csuper learns weekly usage %. Options: parse Claude Code's /usage or /status output in the PTY, parse limit-warning banners, or leave it blank until a banner appears.]` Until this is decided, show `—` in the panel.
- **Desktop notification mirroring.** Show a toast in the TUI whenever csuper fires an `osascript` notification.
- **History view.** A per-session timeline of cycles, limits, and anomalies, built from the JSONL logs.
- **Daily summary.** `csuper report --since 24h` totals cycles, time spent waiting on limits, and anomalies.
- **tmux integration.** `csuper dash --split` opens the dashboard in a tmux pane beside the supervised session.
- **Shell prompt segment.** A fast `csuper status --short` for a starship or zsh prompt.
- **Linux support.** Swap `caffeinate` for `systemd-inhibit` and `osascript` for `notify-send`.

---

## 10. Agent Completion Protocol

Implement incrementally: registry → logger → IPC subscribe/control → one-shot commands → TUI. Verify each step with `npm test`. When the requested feature, fix, or refactor is complete, tested, and verified, end the final response with this token on its own line:

::DONE::
