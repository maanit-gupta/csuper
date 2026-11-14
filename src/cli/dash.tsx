import fs from "node:fs";
import path from "node:path";
import { render, useApp, useInput, useStdout } from "ink";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { loadConfig, type Config, type DashboardConfig } from "../config.js";
import { matchesFilter, nextLevel, parseLogLine } from "../log-filter.js";
import { dashLog, type LogRecord } from "../logger.js";
import { logsDir } from "../paths.js";
import type { ControlAction } from "../protocol.js";
import { listSessions, type SessionEntry } from "../session-registry.js";
import type { DashState } from "../state.js";
import { SessionClient, type ConnStatus } from "./client.js";
import { DashView, FOCUS, initialUi, PANEL_COUNT, type UiState } from "./DashView.js";

export interface DashOptions {
  session?: string;
}

/** Last `maxLines` records of a JSONL file, reading at most ~2 KiB per line from the end. */
export function readLogTail(file: string, maxLines: number): LogRecord[] {
  try {
    const st = fs.statSync(file);
    const want = Math.min(st.size, Math.max(64 * 1024, maxLines * 2048));
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(want);
      fs.readSync(fd, buf, 0, want, st.size - want);
      const lines = buf.toString("utf8").split("\n");
      if (want < st.size) lines.shift(); // first line is probably partial
      const recs = lines.map(parseLogLine).filter((r): r is LogRecord => r !== null);
      return recs.slice(-maxLines);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
}

const recKey = (r: LogRecord) => `${r.ts}|${r.event}|${r.msg}`;

function reportError(where: string, e: unknown) {
  dashLog().error("dash.error", `${where}: ${(e as Error)?.message ?? String(e)}`, { stack: (e as Error)?.stack });
}

export function App({ opts, config, configPath }: { opts: DashOptions; config: Config; configPath: string | null }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [size, setSize] = useState({ columns: stdout.columns || 100, rows: stdout.rows || 30 });
  const [cfg, setCfg] = useState<DashboardConfig>(config.dashboard);
  const general = config.general;
  const [ui, setUi] = useState<UiState>(() => initialUi(config.dashboard));
  const [sessions, setSessions] = useState<SessionEntry[]>([]);
  const [current, setCurrent] = useState<SessionEntry | null>(null);
  const [state, setState] = useState<DashState | null>(null);
  const [conn, setConn] = useState<ConnStatus>("disconnected");
  const [logs, setLogs] = useState<LogRecord[]>([]);
  const [now, setNow] = useState(Date.now());
  const [handoverLines, setHandoverLines] = useState<string[] | null>(null);
  const [cfgPath, setCfgPath] = useState<string | null>(configPath);
  const clientRef = useRef<SessionClient | null>(null);
  const msgTimer = useRef<NodeJS.Timeout | null>(null);
  const pinned = opts.session || process.env.CSUPER_SESSION || null;

  const flash = useCallback((text: string, color = "green") => {
    setUi((u) => ({ ...u, message: { text, color } }));
    if (msgTimer.current) clearTimeout(msgTimer.current);
    msgTimer.current = setTimeout(() => setUi((u) => ({ ...u, message: null })), 4000);
  }, []);

  // Terminal size
  useEffect(() => {
    const onResize = () => setSize({ columns: stdout.columns || 100, rows: stdout.rows || 30 });
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  // Fallback redraw so countdowns keep ticking without events (docs/dashboard-spec.md §8.4: computed from absolute times)
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), cfg.refresh_fallback_ms);
    return () => clearInterval(t);
  }, [cfg.refresh_fallback_ms]);

  // Session discovery: initial pick, plus polling while the picker/switcher is open
  const refreshSessions = useCallback(async () => {
    try {
      const list = await listSessions();
      setSessions(list);
      return list;
    } catch (e) {
      reportError("listSessions", e);
      return [];
    }
  }, []);

  useEffect(() => {
    void refreshSessions().then((list) => {
      if (pinned) {
        const s = list.find((x) => x.id === pinned);
        if (s) setCurrent(s);
        else flash(`session ${pinned} not found`, "red");
        return;
      }
      const live = list.filter((s) => s.status === "live");
      if (live.length === 1) setCurrent(live[0]);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const pickerOpen = ui.mode === "switcher" || !current;
  useEffect(() => {
    if (!pickerOpen) return;
    const t = setInterval(async () => {
      const list = await refreshSessions();
      // Nobody chosen yet and exactly one live session appeared → open it.
      if (!current && !pinned) {
        const live = list.filter((s) => s.status === "live");
        if (live.length === 1) setCurrent(live[0]);
      }
    }, 2000);
    return () => clearInterval(t);
  }, [pickerOpen, current, pinned, refreshSessions]);

  // Connection lifecycle for the current session
  useEffect(() => {
    if (!current) return;
    const logFile = path.join(logsDir(), `${current.id}.jsonl`);
    const client = new SessionClient({ sockPath: current.sockPath, maxBackoffMs: general.reconnect_max_backoff_ms });
    clientRef.current = client;
    setState(null);
    setLogs([]);
    let recentKeys = new Set<string>();
    client.on("status", setConn);
    client.on("snapshot", () => {
      // Fresh snapshot (also after reconnect): reload history from the file.
      const tail = readLogTail(logFile, cfg.log_tail_lines);
      recentKeys = new Set(tail.slice(-100).map(recKey));
      setLogs(tail);
    });
    client.on("state", (s) => setState(s));
    client.on("log", (r) => {
      if (recentKeys.has(recKey(r))) return;
      setLogs((prev) => {
        const next = prev.length >= cfg.log_tail_lines ? prev.slice(prev.length - cfg.log_tail_lines + 1) : prev.slice();
        next.push(r);
        return next;
      });
    });
    client.on("versionMismatch", (v) => setUi((u) => ({ ...u, versionWarning: `protocol v${v} ≠ dash v1 — update csuper` })));
    client.start();
    if (current.info?.config_path) setCfgPath(current.info.config_path);
    return () => {
      client.removeAllListeners();
      client.stop();
      if (clientRef.current === client) clientRef.current = null;
    };
  }, [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Config hot-reload
  useEffect(() => {
    if (!cfgPath || !fs.existsSync(cfgPath)) return;
    let w: fs.FSWatcher | null = null;
    let debounce: NodeJS.Timeout | null = null;
    try {
      w = fs.watch(cfgPath, () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          try {
            const { config: c } = loadConfig(cfgPath);
            setCfg(c.dashboard);
            dashLog().info("config.reloaded", `reloaded ${cfgPath}`);
          } catch (e) {
            reportError("config reload (keeping previous config)", e);
            flash("config reload failed — see dash.jsonl", "red");
          }
        }, 150);
      });
    } catch (e) {
      reportError("watch config", e);
    }
    return () => {
      w?.close();
      if (debounce) clearTimeout(debounce);
    };
  }, [cfgPath, flash]);

  // handover.md preview: re-read when it changes
  const hoPath = state?.handover.path;
  const hoMtime = state?.handover.mtime;
  useEffect(() => {
    if (!hoPath || !ui.showHandover) return;
    try {
      setHandoverLines(fs.readFileSync(hoPath, "utf8").replace(/\n$/, "").split("\n"));
    } catch {
      setHandoverLines(null);
    }
  }, [hoPath, hoMtime, ui.showHandover]);

  const filtered = useMemo(
    () => logs.filter((r) => matchesFilter(r, { level: ui.level, text: ui.filterText || undefined })),
    [logs, ui.level, ui.filterText],
  );

  const control = useCallback(
    async (action: ControlAction) => {
      const c = clientRef.current;
      if (!c) return flash("not connected", "red");
      const ack = await c.control(action);
      flash(ack.ok ? `✓ ${action}` : `✗ ${action}: ${ack.error}`, ack.ok ? "green" : "red");
    },
    [flash],
  );

  const quit = useCallback(() => {
    clientRef.current?.stop();
    exit();
  }, [exit]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") return quit();

    // Session picker / switcher
    if (ui.mode === "switcher" || !current) {
      const n = sessions.length;
      if (key.upArrow) return setUi((u) => ({ ...u, switcherIndex: n ? (u.switcherIndex - 1 + n) % n : 0 }));
      if (key.downArrow) return setUi((u) => ({ ...u, switcherIndex: n ? (u.switcherIndex + 1) % n : 0 }));
      if (key.return && n) {
        const s = sessions[Math.min(ui.switcherIndex, n - 1)];
        setUi((u) => ({ ...u, mode: "normal", logScroll: 0, handoverScroll: 0 }));
        if (s.id !== current?.id) setCurrent(s);
        return;
      }
      if (key.escape || input === "q") {
        if (!current) return quit();
        return setUi((u) => ({ ...u, mode: "normal" }));
      }
      return;
    }

    if (ui.mode === "help") return setUi((u) => ({ ...u, mode: "normal" }));

    if (ui.mode === "confirm-skip") {
      setUi((u) => ({ ...u, mode: "normal" }));
      if (input === "y" || input === "Y") void control("ratelimit.skip_wait");
      else flash("skip-wait cancelled", "yellow");
      return;
    }

    if (ui.mode === "filter") {
      if (key.return) return setUi((u) => ({ ...u, mode: "normal", logScroll: 0 }));
      if (key.escape) return setUi((u) => ({ ...u, mode: "normal", filterText: "", logScroll: 0 }));
      if (key.backspace || key.delete) return setUi((u) => ({ ...u, filterText: u.filterText.slice(0, -1) }));
      if (input && !key.ctrl && !key.meta) return setUi((u) => ({ ...u, filterText: u.filterText + input }));
      return;
    }

    // Normal mode
    const logFocused = ui.logFullscreen || ui.focus === FOCUS.log;
    const page = Math.max(1, size.rows - 25);
    if (key.tab) return setUi((u) => ({ ...u, focus: (u.focus + (key.shift ? PANEL_COUNT - 1 : 1)) % PANEL_COUNT }));
    if (key.escape && ui.logFullscreen) return setUi((u) => ({ ...u, logFullscreen: false }));
    if (key.upArrow || key.pageUp) {
      const step = key.pageUp ? page : 1;
      if (logFocused) return setUi((u) => ({ ...u, logScroll: Math.min(Math.max(0, filtered.length - 1), u.logScroll + step) }));
      if (ui.focus === FOCUS.git) return setUi((u) => ({ ...u, handoverScroll: Math.max(0, u.handoverScroll - step) }));
      return;
    }
    if (key.downArrow || key.pageDown) {
      const step = key.pageDown ? page : 1;
      if (logFocused) return setUi((u) => ({ ...u, logScroll: Math.max(0, u.logScroll - step) }));
      if (ui.focus === FOCUS.git)
        return setUi((u) => ({
          ...u,
          handoverScroll: Math.min(Math.max(0, (handoverLines?.length ?? 0) - cfg.handover_preview_lines), u.handoverScroll + step),
        }));
      return;
    }
    switch (input) {
      case "q":
        return quit();
      case "1":
      case "2":
      case "3":
      case "4":
      case "5":
      case "6":
        return setUi((u) => ({ ...u, focus: Number(input) - 1, logFullscreen: false }));
      case "s":
        void refreshSessions();
        return setUi((u) => ({ ...u, mode: "switcher", switcherIndex: Math.max(0, sessions.findIndex((x) => x.id === current.id)) }));
      case "?":
        return setUi((u) => ({ ...u, mode: "help" }));
      case "l":
        return setUi((u) => ({ ...u, logFullscreen: !u.logFullscreen, logScroll: 0 }));
      case "/":
        return setUi((u) => ({ ...u, mode: "filter" }));
      case "f":
        return setUi((u) => ({ ...u, level: nextLevel(u.level), logScroll: 0 }));
      case "h":
        return setUi((u) => ({ ...u, showHandover: !u.showHandover }));
      case "p":
        if (!state) return flash("no state yet", "red");
        return void control(state.autopilot.enabled ? "autopilot.pause" : "autopilot.resume");
      case "c":
        if (!state?.countdown) return flash("no /clear countdown pending", "yellow");
        return void control("countdown.cancel");
      case "w":
        if (state?.rateLimit.status !== "waiting") return flash("not waiting on a rate limit", "yellow");
        if (cfg.confirm_skip_wait) return setUi((u) => ({ ...u, mode: "confirm-skip" }));
        return void control("ratelimit.skip_wait");
    }
  });

  return (
    <DashView
      state={state}
      conn={conn}
      sessionId={current?.id ?? null}
      now={now}
      cfg={cfg}
      ui={ui}
      logs={filtered}
      handoverLines={handoverLines}
      sessions={sessions}
      columns={size.columns}
      rows={size.rows}
    />
  );
}

const ENTER_ALT = "\x1b[?1049h\x1b[H";
const LEAVE_ALT = "\x1b[?25h\x1b[?1049l";

/** Entry point for `csuper dash`. Restores the terminal on every exit path (docs/dashboard-spec.md §7). */
export async function runDash(opts: DashOptions): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write("csuper dash needs an interactive terminal; use `csuper status` for scripts\n");
    return 64;
  }
  let loaded: { config: Config; path: string | null };
  try {
    loaded = loadConfig();
  } catch (e) {
    process.stderr.write(`csuper dash: invalid config: ${(e as Error).message}\n`);
    return 78;
  }

  // Internal diagnostics go to dash.jsonl, never the screen.
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    console[m] = (...args: unknown[]) => dashLog().log(m === "log" ? "info" : m, "dash.error", args.map(String).join(" "));
  }

  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    try {
      process.stdin.setRawMode?.(false);
    } catch {
      /* ignore */
    }
    process.stdout.write(LEAVE_ALT);
  };
  process.stdout.write(ENTER_ALT);
  process.on("exit", restore);

  const instance = render(<App opts={opts} config={loaded.config} configPath={loaded.path} />, {
    exitOnCtrlC: false,
    patchConsole: false,
  });
  const bail = (code: number) => {
    try {
      instance.unmount();
    } catch {
      /* ignore */
    }
    restore();
    process.exit(code);
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => bail(0));
  process.on("uncaughtException", (e) => {
    reportError("uncaughtException", e);
    bail(1);
  });
  process.on("unhandledRejection", (e) => {
    reportError("unhandledRejection", e);
    bail(1);
  });

  await instance.waitUntilExit();
  restore();
  return 0;
}

// Shares this bundle's Ink/React with `csuper resume`'s conversation picker.
export { pickSessions } from "./AdoptPicker.js";
