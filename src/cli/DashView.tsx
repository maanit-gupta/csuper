import { Box, Text } from "ink";
import React from "react";
import type { DashboardConfig } from "../config.js";
import { levelLabel, type LevelFilter } from "../log-filter.js";
import type { LogRecord } from "../logger.js";
import type { SessionEntry } from "../session-registry.js";
import type { DashState } from "../state.js";
import type { ConnStatus } from "./client.js";
import { shortenHome } from "./format.js";
import { CyclesPanel, cyclesPanelHeight } from "./panels/CyclesPanel.js";
import { GitPanel } from "./panels/GitPanel.js";
import { LogPanel } from "./panels/LogPanel.js";
import { RateLimitPanel } from "./panels/RateLimitPanel.js";
import { SessionPanel } from "./panels/SessionPanel.js";
import { TriggersPanel } from "./panels/TriggersPanel.js";

export type Mode = "normal" | "filter" | "confirm-skip" | "help" | "switcher";
export const PANEL_COUNT = 6;
/** Focus indexes (0-based) of the panels that scroll. */
export const FOCUS = { session: 0, rateLimit: 1, cycles: 2, triggers: 3, git: 4, log: 5 } as const;

export interface UiState {
  focus: number; // 0..5, see FOCUS
  mode: Mode;
  logFullscreen: boolean;
  showHandover: boolean;
  handoverScroll: number;
  logScroll: number;
  level: LevelFilter;
  filterText: string;
  message: { text: string; color: string } | null;
  versionWarning: string | null;
  switcherIndex: number;
}

export function initialUi(cfg: DashboardConfig): UiState {
  return {
    focus: 0,
    mode: "normal",
    logFullscreen: false,
    showHandover: true,
    handoverScroll: 0,
    logScroll: 0,
    level: cfg.default_log_level,
    filterText: "",
    message: null,
    versionWarning: null,
    switcherIndex: 0,
  };
}

export interface DashViewProps {
  state: DashState | null;
  conn: ConnStatus;
  sessionId: string | null;
  now: number;
  cfg: DashboardConfig;
  ui: UiState;
  logs: LogRecord[]; // filtered
  handoverLines: string[] | null;
  sessions: SessionEntry[];
  columns: number;
  rows: number;
}

export const HELP: Array<[string, string]> = [
  ["Tab / Shift+Tab", "Move focus between panels"],
  ["1–6", "Jump to a panel"],
  ["↑ ↓ PgUp PgDn", "Scroll the focused log / handover preview"],
  ["s", "Session switcher"],
  ["p", "Pause / resume autopilot"],
  ["c", "Cancel pending /clear countdown"],
  ["w", "Skip rate-limit wait (asks y/N)"],
  ["l", "Expand the log stream to full screen"],
  ["/", "Filter logs (text); Enter keeps, Esc clears"],
  ["f", "Cycle log level: all → info+ → warn+ → error"],
  ["h", "Toggle the handover.md preview"],
  ["?", "Help overlay"],
  ["q / Ctrl+C", "Quit the dashboard (the session keeps running)"],
];

function Help() {
  return (
    <Box flexDirection="column" borderStyle="double" borderColor="cyan" paddingX={2} paddingY={1}>
      <Text bold color="cyan">
        csuper dash — keys
      </Text>
      <Text> </Text>
      {HELP.map(([k, d]) => (
        <Box key={k}>
          <Box width={18}>
            <Text bold>{k}</Text>
          </Box>
          <Text>{d}</Text>
        </Box>
      ))}
      <Text> </Text>
      <Text dimColor>Keys act only in this terminal; the supervised session is never touched directly. Press any key to close.</Text>
    </Box>
  );
}

function Switcher({ sessions, index, current, pinnedMissing }: { sessions: SessionEntry[]; index: number; current: string | null; pinnedMissing?: boolean }) {
  return (
    <Box flexDirection="column" borderStyle="double" borderColor="cyan" paddingX={2} paddingY={1}>
      <Text bold color="cyan">
        {current ? "Switch session" : "Pick a csuper session"}
      </Text>
      <Text> </Text>
      {sessions.length === 0 ? (
        <Text dimColor>{pinnedMissing ? "That session was not found. " : ""}No csuper sessions yet. Start one in another terminal with `csuper` or `csuper resume`; it will appear here automatically.</Text>
      ) : (
        sessions.map((s, i) => (
          <Text key={s.id} inverse={i === index} wrap="truncate">
            {/* Marker before the cwd so a long path can't truncate it away */}
            {i === index ? "›" : " "} {s.id} {s.status === "stale" ? "[stale]" : "       "} {s.id === current ? "(current) " : "          "}
            {s.info ? shortenHome(s.info.cwd) : "?"}
          </Text>
        ))
      )}
      <Text> </Text>
      <Text dimColor>{sessions.length ? "↑↓ select · Enter open · " : ""}Esc {current ? "back" : "quit"}</Text>
    </Box>
  );
}

/** "cycles 3/20", always on the status bar once a session is attached. */
function CyclesBadge({ state }: { state: DashState | null }) {
  if (!state) return null;
  const c = state.cycles;
  const color = state.autopilot.pausedReason === "cycle_failed" ? "red" : c.current ? "yellow" : "cyan";
  return (
    <Text color={color} bold>
      cycles {c.used}/{c.max || "∞"}
      {c.current ? ` (${c.current.step}/${c.current.total})` : ""}{" "}
    </Text>
  );
}

function StatusBar({ props }: { props: DashViewProps }) {
  const { ui, conn, sessionId } = props;
  const attached = sessionId && ui.mode !== "switcher";
  if (ui.mode === "confirm-skip") {
    return (
      <Text color="yellow" bold wrap="truncate">
        Skip the rate-limit wait and send resume_prompt now? It may hit the limit again. [y/N]{" "}
        <CyclesBadge state={props.state} />
      </Text>
    );
  }
  if (ui.mode === "filter") {
    return (
      <Text wrap="truncate">
        {attached ? <CyclesBadge state={props.state} /> : null}
        <Text color="cyan">/</Text>
        {ui.filterText}
        <Text inverse> </Text>
        <Text dimColor> Enter keep · Esc clear</Text>
      </Text>
    );
  }
  if (ui.mode === "switcher" || !sessionId) {
    // Picker: no session is attached, so connection state and session controls don't apply
    const waiting = props.sessions.length === 0;
    return (
      <Text wrap="truncate">
        <Text color={waiting ? "yellow" : "cyan"} bold>
          ● {waiting ? "WAITING FOR A SESSION" : sessionId ? "SWITCH SESSION" : "PICK A SESSION"}
        </Text>
        <Text dimColor>
          {" "}
          {waiting ? "" : "↑↓ select · Enter open · "}Esc/q {sessionId ? "back" : "quit"}
        </Text>
      </Text>
    );
  }
  const connColor = conn === "connected" ? "green" : conn === "connecting" ? "yellow" : "red";
  return (
    <Text wrap="truncate">
      <Text color={connColor} bold>
        ● {conn.toUpperCase()}
      </Text>
      <Text> {sessionId ?? "—"} </Text>
      <CyclesBadge state={props.state} />
      {ui.message ? <Text color={ui.message.color}>{ui.message.text} </Text> : null}
      {ui.versionWarning ? <Text color="red">{ui.versionWarning} </Text> : null}
      <Text dimColor>
        log {levelLabel(ui.level)}
        {ui.filterText ? ` /${ui.filterText}` : ""} · p pause · c cancel · w skip · s sessions · ? help · q quit
      </Text>
    </Text>
  );
}

/** Pure, prop-driven dashboard renderer (snapshot-tested). */
export function DashView(props: DashViewProps) {
  const { state, ui, cfg, now, rows, columns } = props;
  const height = Math.max(10, rows - 1); // leave the last line free so Ink never scrolls
  const tf = cfg.time_format;

  let body: React.ReactNode;
  if (ui.mode === "help") body = <Help />;
  else if (ui.mode === "switcher" || !props.sessionId)
    body = <Switcher sessions={props.sessions} index={ui.switcherIndex} current={props.sessionId} />;
  else if (!state)
    body = (
      <Box flexGrow={1} alignItems="center" justifyContent="center">
        <Text color={props.conn === "disconnected" ? "red" : "yellow"}>
          {props.conn === "disconnected" ? "DISCONNECTED — retrying…" : `Connecting to ${props.sessionId}…`}
        </Text>
      </Box>
    );
  else if (ui.logFullscreen)
    body = (
      <LogPanel records={props.logs} focused height={height - 1} level={ui.level} text={ui.filterText} scroll={ui.logScroll} timeFormat={tf} fullscreen />
    );
  else {
    const recentCount = Math.min(cfg.recent_triggers_shown, Math.max(1, state.triggers.recent.length));
    const previewCount = ui.showHandover ? Math.min(cfg.handover_preview_lines, Math.max(1, props.handoverLines?.length ?? 1)) : 1;
    const topH = 12; // Rate Limits has 9 rows; Session has 8 (+1 "origin" when adopted)
    const midWanted = Math.max(1 + 5 + 1 + recentCount, 1 + 3 + previewCount) + 2;
    const banner = props.conn !== "connected" ? 1 : 0;
    const avail = height - 1 - banner; // minus status bar
    const minLog = 5;
    const minMid = 6;
    // Short terminals: Cycles shrinks to its two summary rows before the log loses lines.
    const cyclesWanted = cyclesPanelHeight(Math.min(10, state.cycles.recent.length));
    const cyclesH = Math.max(5, Math.min(cyclesWanted, avail - topH - minMid - minLog));
    const midH = Math.max(6, Math.min(midWanted, avail - topH - cyclesH - minLog));
    const logH = Math.max(3, avail - topH - cyclesH - midH);
    const narrow = columns < 100;
    body = (
      <>
        {banner ? (
          <Text color="red" bold inverse>
            {" "}
            DISCONNECTED — showing last known state, reconnecting…{" "}
          </Text>
        ) : null}
        <Box height={topH} flexDirection={narrow ? "column" : "row"} overflow="hidden">
          <SessionPanel state={state} now={now} focused={ui.focus === FOCUS.session} height={topH} />
          <RateLimitPanel state={state} now={now} focused={ui.focus === FOCUS.rateLimit} timeFormat={tf} height={topH} />
        </Box>
        <CyclesPanel state={state} now={now} focused={ui.focus === FOCUS.cycles} timeFormat={tf} height={cyclesH} />
        <Box height={midH} flexDirection="row" overflow="hidden">
          <TriggersPanel state={state} now={now} focused={ui.focus === FOCUS.triggers} limit={cfg.recent_triggers_shown} timeFormat={tf} height={midH} />
          <GitPanel
            state={state}
            now={now}
            focused={ui.focus === FOCUS.git}
            showHandover={ui.showHandover}
            handoverLines={props.handoverLines}
            handoverScroll={ui.handoverScroll}
            previewLines={Math.max(1, Math.min(cfg.handover_preview_lines, midH - 6))}
            height={midH}
          />
        </Box>
        <LogPanel records={props.logs} focused={ui.focus === FOCUS.log} height={logH} level={ui.level} text={ui.filterText} scroll={ui.logScroll} timeFormat={tf} />
      </>
    );
  }

  return (
    <Box flexDirection="column" width={columns} height={height}>
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {body}
      </Box>
      <StatusBar props={props} />
    </Box>
  );
}
