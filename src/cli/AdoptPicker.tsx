import { Box, render, Text, useApp, useInput, useStdout } from "ink";
import React, { useState } from "react";
import type { AdoptStatus, ClaudeSession } from "../supervisor/claude-sessions.js";
import { shortenHome, sinceIso } from "./format.js";

export interface PickerRow {
  session: ClaudeSession;
  status: AdoptStatus;
  pid: number | null;
}

const STATUS_COLOR: Record<AdoptStatus, string> = { live: "yellow", "possibly live": "yellow", ended: "green", "already csuper": "magenta" };

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));

export function AdoptPickerView(p: { rows: PickerRow[]; index: number; selected: Set<string>; multi: boolean; title: string; subtitle: string; now: number; rows_: number; cols: number }) {
  const { rows, index, selected, multi, now } = p;
  // Header (4) + footer (2) + border/padding (4); one line per entry.
  const visible = Math.max(3, p.rows_ - 11);
  const start = Math.min(Math.max(0, index - Math.floor(visible / 2)), Math.max(0, rows.length - visible));
  const shown = rows.slice(start, start + visible);
  const projW = Math.max(14, Math.min(32, Math.floor(p.cols * 0.22)));
  return (
    <Box flexDirection="column" borderStyle="double" borderColor="cyan" paddingX={2} paddingY={1}>
      <Text bold color="cyan">
        {p.title}
      </Text>
      <Text dimColor wrap="truncate">
        {p.subtitle}
      </Text>
      <Text> </Text>
      <Text dimColor wrap="truncate">
        {"   "}
        {multi ? "    " : ""}
        {pad("session", 9)}
        {pad("project", projW + 1)}
        {"last activity".padStart(13)} {"size".padStart(7)} {pad("status", 15)}first prompt
      </Text>
      {start > 0 ? <Text dimColor>  ↑ {start} more</Text> : null}
      {shown.map((r, i) => {
        const cur = start + i === index;
        const s = r.session;
        const status = r.status === "live" || r.status === "possibly live" ? `${r.status}${r.pid ? ` ${r.pid}` : ""}` : r.status;
        return (
          <Text key={s.id} inverse={cur} wrap="truncate">
            {cur ? "›" : " "} {multi ? (selected.has(s.id) ? "[x] " : "[ ] ") : ""}
            <Text color={cur ? undefined : "cyan"}>{s.id.slice(0, 8)}</Text> {pad(shortenHome(s.cwd), projW)} {sinceIso(s.updatedAt, now).padStart(13)}{" "}
            {formatSize(s.size).padStart(7)} <Text color={cur ? undefined : STATUS_COLOR[r.status]}>{pad(status, 15)}</Text>
            {s.title ?? s.firstPrompt}
          </Text>
        );
      })}
      {start + visible < rows.length ? <Text dimColor>  ↓ {rows.length - start - visible} more</Text> : null}
      <Text> </Text>
      <Text dimColor>
        ↑↓ move · {multi ? `Space select (${selected.size}) · Enter adopt selected` : "Enter resume under csuper"} · Esc cancel
      </Text>
    </Box>
  );
}

function Picker(p: { rows: PickerRow[]; multi: boolean; title: string; subtitle: string; onDone: (ids: string[] | null) => void }) {
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const { exit } = useApp();
  const { stdout } = useStdout();
  const n = p.rows.length;
  const finish = (ids: string[] | null) => {
    p.onDone(ids);
    exit();
  };
  useInput((input, key) => {
    if (key.upArrow || input === "k") setIndex((i) => (i - 1 + n) % n);
    else if (key.downArrow || input === "j") setIndex((i) => (i + 1) % n);
    else if (key.pageUp) setIndex((i) => Math.max(0, i - 10));
    else if (key.pageDown) setIndex((i) => Math.min(n - 1, i + 10));
    else if (input === " " && p.multi) {
      const id = p.rows[index].session.id;
      setSelected((s) => {
        const next = new Set(s);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    } else if (key.return) {
      // Enter with nothing ticked takes the highlighted row; keep list order otherwise.
      finish(selected.size ? p.rows.filter((r) => selected.has(r.session.id)).map((r) => r.session.id) : [p.rows[index].session.id]);
    } else if (key.escape || input === "q" || (key.ctrl && input === "c")) finish(null);
  });
  return (
    <AdoptPickerView
      rows={p.rows}
      index={index}
      selected={selected}
      multi={p.multi}
      title={p.title}
      subtitle={p.subtitle}
      now={Date.now()}
      rows_={stdout.rows || 24}
      cols={stdout.columns || 80}
    />
  );
}

const ENTER_ALT = "\x1b[?1049h\x1b[H";
const LEAVE_ALT = "\x1b[?25h\x1b[?1049l";

/** Full-screen picker; resolves to the chosen conversation IDs, or null if cancelled. */
export async function pickSessions(rows: PickerRow[], o: { multi: boolean; title: string; subtitle: string }): Promise<string[] | null> {
  let chosen: string[] | null = null;
  process.stdout.write(ENTER_ALT);
  const restore = () => process.stdout.write(LEAVE_ALT);
  process.once("exit", restore);
  const inst = render(<Picker rows={rows} {...o} onDone={(ids) => (chosen = ids)} />, { exitOnCtrlC: false, patchConsole: false });
  try {
    await inst.waitUntilExit();
  } finally {
    inst.cleanup();
    process.off("exit", restore);
    restore();
  }
  return chosen;
}
