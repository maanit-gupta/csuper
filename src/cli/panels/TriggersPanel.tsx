import { Box, Text } from "ink";
import React from "react";
import type { DashState } from "../../state.js";
import { clock, sinceIso, untilIso } from "../format.js";
import { Panel, Row } from "./Panel.js";

export function TriggersPanel({
  state,
  now,
  focused,
  limit,
  timeFormat,
  height,
}: {
  state: DashState;
  now: number;
  focused: boolean;
  limit: number;
  timeFormat: "24h" | "12h";
  height?: number;
}) {
  const a = state.anomalies;
  const recent = state.triggers.recent.slice(-limit).reverse();
  const thrash = Object.entries(a.editThrash).sort((x, y) => y[1] - x[1]);
  const streakHot = a.threshold > 0 && a.toolFailureStreak >= Math.max(1, a.threshold - 1);
  return (
    <Panel title="Triggers & Anomalies" index={4} focused={focused} flexGrow={1} height={height}>
      <Row label="countdown">
        {state.countdown ? (
          <Text color="yellow" bold>
            {state.countdown.commands.join(" ")} in {untilIso(state.countdown.firesAt, now)}
            <Text dimColor bold={false}>
              {" "}
              · c cancel ({state.countdown.trigger})
            </Text>
          </Text>
        ) : (
          <Text dimColor>none</Text>
        )}
      </Row>
      <Row label="fail streak">
        <Text color={streakHot ? "red" : undefined}>
          {a.toolFailureStreak} / {a.threshold}
        </Text>
      </Row>
      <Row label="edit thrash">
        {thrash.length ? thrash.slice(0, 3).map(([f, n]) => `${f}×${n}`).join("  ") : <Text dimColor>none</Text>}
      </Row>
      <Row label="protected">
        {a.protectedViolations.length ? <Text color="red">{a.protectedViolations.join(", ")}</Text> : <Text dimColor>no violations</Text>}
      </Row>
      <Row label="last anomaly">
        {a.last ? (
          <>
            <Text color="red">{a.last.kind}</Text> {sinceIso(a.last.ts, now)} → {a.last.actions.join(", ")}
          </>
        ) : (
          <Text dimColor>none</Text>
        )}
      </Row>
      <Text dimColor>recent triggers</Text>
      {recent.length === 0 ? <Text dimColor>  (none yet)</Text> : null}
      {recent.map((t, i) => (
        <Box key={`${t.ts}-${i}`}>
          <Text wrap="truncate">
            <Text dimColor>{clock(t.ts, timeFormat)} </Text>
            <Text color="cyan">{t.name}</Text> <Text>{t.keyword}</Text>
            <Text dimColor> → {t.commands.join(" ")}</Text>
          </Text>
        </Box>
      ))}
    </Panel>
  );
}
