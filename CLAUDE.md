# CLAUDE.md — csuper (core spec)

> **Placeholder.** The original core csuper spec was overwritten when the dashboard spec was
> saved as `claude.md` (macOS treats `CLAUDE.md` and `claude.md` as the same file), and the
> repo has no git history to restore it from. Paste the core spec here to replace this file.

- Dashboard spec (`csuper dash`, `status`, `logs`, `sessions`, `ctl`): [`docs/dashboard-spec.md`](docs/dashboard-spec.md)
- Its rules apply to all of `src/`: no stdout/stderr writes while a PTY is live, diagnostics go
  to the JSONL logs, every config key lives in both `csuper.config.yaml` and `src/config.ts`,
  and `npm test` passes before a step is called done.
