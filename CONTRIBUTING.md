# Contributing to csuper

Thanks for looking. csuper is small and opinionated; these rules keep it that way.

## Setup

```bash
git clone https://github.com/maanit-gupta/csuper.git && cd csuper
npm install
npm run typecheck && npm test      # must pass before any change is "done"
npm run build                      # bundle to dist/
npm run test:e2e                   # end-to-end, real pty, fake claude (needs python3)
```

Requires macOS on Apple Silicon and Node.js ≥ 20 (see [INSTALL.md](INSTALL.md)).

## Rules that apply to everything in `src/`

1. **No stdout/stderr writes while a pty is live.** The pty owns the terminal. Diagnostics go to the JSONL log (`src/logger.ts`).
2. **Every config key lives in two places:** `csuper.config.yaml` and the zod schema in `src/config.ts`. A key in only one is a bug.
3. **Confirm or stop.** Anything the autopilot types into Claude must be followed by a confirmation signal within a timeout; a missing one pauses autopilot and notifies. Don't add blind retries or `sleep`-based sequencing.
4. **Only the supervisor writes to the pty.** The dashboard and CLI commands talk to the socket and may only send the allow-listed control actions in `src/protocol.ts`.
5. **The hook script stays dependency-free** and always exits `0` quickly.
6. **Tests first for logic.** The autopilot is I/O-free (`Host` interface) so it can be driven with a stub claude and fake timers; keep it that way. TUI changes get snapshot tests (`ink-testing-library`).

## Pull requests

- Keep changes focused; describe the behaviour change and how you verified it.
- Update `README.md` / `INSTALL.md` / `docs/dashboard-spec.md` when behaviour or flags change.
- Log new event names in `src/logger.ts`.

## Reporting bugs

Open an issue with your macOS and Node versions (`sw_vers`, `node -v`), `claude --version`, the command you ran, and the relevant lines from `csuper logs --raw` (redact anything private). For usage-limit parsing problems, the matching entry from `~/.csuper/logs/ratelimit-samples.jsonl` is the most useful thing you can attach.
