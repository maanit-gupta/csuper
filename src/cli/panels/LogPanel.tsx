import { Box, Text } from "ink";
import React from "react";
import { formatTime, levelLabel, type LevelFilter } from "../../log-filter.js";
import type { LogRecord } from "../../logger.js";
import { Panel } from "./Panel.js";

const LEVEL_COLOR: Record<string, string> = { debug: "gray", info: "cyan", warn: "yellow", error: "red" };

export function LogPanel({
  records,
  focused,
  height,
  level,
  text,
  scroll,
  timeFormat,
  fullscreen,
}: {
  /** Already-filtered records, oldest first. */
  records: LogRecord[];
  focused: boolean;
  height: number;
  level: LevelFilter;
  text: string;
  /** Lines scrolled back from the bottom (0 = follow). */
  scroll: number;
  timeFormat: "24h" | "12h";
  fullscreen?: boolean;
}) {
  const body = Math.max(1, height - 3); // border + title
  const end = Math.max(0, records.length - scroll);
  const visible = records.slice(Math.max(0, end - body), end);
  const right = `level ${levelLabel(level)}${text ? ` · /${text}` : ""}${scroll ? ` · ↑${scroll}` : " · following"}${fullscreen ? " · esc to exit" : ""}`;
  return (
    <Panel title="Log Stream" index={6} focused={focused} height={height} right={right}>
      {visible.length === 0 ? <Text dimColor>(no log lines match)</Text> : null}
      {visible.map((r, i) => (
        <Box key={`${r.ts}-${i}`}>
          <Text wrap="truncate">
            <Text dimColor>{formatTime(r.ts, timeFormat)} </Text>
            <Text color={LEVEL_COLOR[r.level]}>{r.level.toUpperCase().padEnd(5)}</Text>
            <Text> {r.event.padEnd(24)} </Text>
            <Text>{r.msg}</Text>
            {r.data && Object.keys(r.data).length ? <Text dimColor> {JSON.stringify(r.data)}</Text> : null}
          </Text>
        </Box>
      ))}
    </Panel>
  );
}
