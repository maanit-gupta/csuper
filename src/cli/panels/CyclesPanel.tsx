import { Box, Text } from "ink";
import React from "react";
import type { CycleRecord, DashState } from "../../state.js";
import { clock, formatDuration, sinceIso, untilIso } from "../format.js";
import { Panel, Row } from "./Panel.js";

/** "ok", "failed at clear_confirmed", "cancelled at countdown". */
export function cycleResult(r: CycleRecord): string {
  if (r.result === "ok") return "ok";
  return `${r.result}${r.step ? ` at ${r.step}` : ""}`;
}

const RESULT_COLOR = { ok: "green", failed: "red", cancelled: "yellow" } as const;

/** "4/8 waiting for clear confirmation" plus how long it has left. */
export function currentStepText(s: DashState, now: number): string {
  const c = s.cycles.current;
  if (!c) return "idle";
  const tail =
    c.name === "countdown" && s.countdown
      ? ` · fires in ${untilIso(s.countdown.firesAt, now)} (c cancels)`
      : c.deadline
        ? ` · times out in ${untilIso(c.deadline, now)}`
        : "";
  return `${c.step}/${c.total} ${c.label}${tail}`;
}

/** Height the panel wants for `n` recent rows. */
export const cyclesPanelHeight = (n: number) => 2 + 1 + 2 + 1 + Math.max(1, n);

export function CyclesPanel({
  state,
  now,
  focused,
  timeFormat,
  height,
}: {
  state: DashState;
  now: number;
  focused: boolean;
  timeFormat: "24h" | "12h";
  height: number;
}) {
  const cy = state.cycles;
  // 2 borders + title + 2 summary rows; the table needs a header row plus at least one row.
  const fits = height - 5 - 1;
  const recent = fits > 0 ? cy.recent.slice(-Math.min(10, fits)).reverse() : [];
  const hit = cy.max > 0 && cy.used >= cy.max;
  return (
    <Panel title="Cycles /clear → /next" index={3} focused={focused} height={height} right={`last ${Math.min(10, cy.recent.length)} of ${cy.used + cy.failed}`}>
      <Row label="completed">
        <Text color={hit ? "red" : "green"} bold>
          {cy.used}/{cy.max || "∞"}
        </Text>
        <Text> · failed </Text>
        <Text color={cy.failed ? "red" : undefined}>{cy.failed}</Text>
        <Text dimColor> · last ok </Text>
        {cy.lastOkAt ? (
          <Text>
            {clock(cy.lastOkAt, timeFormat)} <Text dimColor>({sinceIso(cy.lastOkAt, now)})</Text>
          </Text>
        ) : (
          <Text dimColor>—</Text>
        )}
      </Row>
      <Row label="now">
        <Text color={cy.current ? "yellow" : undefined} dimColor={!cy.current} bold={!!cy.current}>
          {currentStepText(state, now)}
        </Text>
      </Row>
      {fits > 0 ? (
        <Box>
          <Text dimColor wrap="truncate">
            {"start".padEnd(9)}
            {"took".padEnd(9)}
            {"result".padEnd(30)}phase
          </Text>
        </Box>
      ) : null}
      {fits > 0 && recent.length === 0 ? <Text dimColor>(no cycles yet)</Text> : null}
      {recent.map((r) => (
        <Box key={r.id}>
          <Text wrap="truncate">
            <Text dimColor>{clock(r.startedAt, timeFormat).padEnd(9)}</Text>
            {formatDuration(r.durationMs).padEnd(9)}
            <Text color={RESULT_COLOR[r.result]}>{cycleResult(r).padEnd(30)}</Text>
            {r.phase ?? <Text dimColor>—</Text>}
          </Text>
        </Box>
      ))}
    </Panel>
  );
}
