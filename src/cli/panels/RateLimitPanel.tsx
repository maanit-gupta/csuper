import { Text } from "ink";
import React from "react";
import type { DashState } from "../../state.js";
import { bar, clock, formatDuration, untilIso } from "../format.js";
import { Panel, Row } from "./Panel.js";

const STATUS_COLOR = { ok: "green", waiting: "yellow", resuming: "cyan", failover: "magenta" } as const;

/** Time spent waiting on limits this session, including a wait in progress. */
export function totalWaitMs(s: DashState, now: number): number {
  const r = s.rateLimit;
  return (r.totalWaitMs ?? 0) + (r.waitStartedAt ? Math.max(0, now - Date.parse(r.waitStartedAt)) : 0);
}

export function RateLimitPanel({
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
  height?: number;
}) {
  const rl = state.rateLimit;
  const pct = rl.weeklyPct;
  const over = pct !== null && rl.weeklyStopPct != null && pct >= rl.weeklyStopPct;
  const active = rl.status === "waiting" || rl.status === "resuming";
  const fo = rl.failovers ?? [];
  const lastFo = fo.at(-1);
  return (
    <Panel title="Rate Limits & Quota" index={2} focused={focused} flexGrow={1} height={height}>
      <Row label="state">
        <Text color={STATUS_COLOR[rl.status]} bold>
          {rl.status}
        </Text>
        {rl.reason ? (
          <Text color={active ? "yellow" : undefined} dimColor={!active}>
            {" "}
            · {active ? "" : "last: "}
            {rl.reason}
            {rl.source ? ` (${rl.source})` : ""}
          </Text>
        ) : null}
        {rl.holding ? <Text color="yellow"> · held: autopilot paused</Text> : null}
      </Row>
      <Row label="resets at">
        {rl.resetAt ? (
          <>
            {clock(rl.resetAt, timeFormat)}
            <Text dimColor> ({untilIso(rl.resetAt, now)})</Text>
          </>
        ) : active ? (
          <Text color="yellow">unreadable — retrying with backoff</Text>
        ) : (
          "—"
        )}
      </Row>
      <Row label="resume at">
        {rl.resumeAt ? (
          <>
            <Text color="yellow" bold>
              {clock(rl.resumeAt, timeFormat)} in {untilIso(rl.resumeAt, now)}
            </Text>
            <Text dimColor> (incl. margin)</Text>
          </>
        ) : rl.status === "resuming" ? (
          <Text color="cyan">resume sent, verifying…</Text>
        ) : (
          "—"
        )}
      </Row>
      <Row label="resumes">
        {rl.resumeAttempts ?? 0} sent · <Text color={(rl.failedResumes ?? 0) > 0 ? "red" : undefined}>{rl.failedResumes ?? 0} failed in a row</Text>
      </Row>
      <Row label="waited">{formatDuration(totalWaitMs(state, now))} this session</Row>
      <Row label="failover">
        {lastFo ? (
          <>
            <Text color={lastFo.restoredAt ? undefined : "magenta"}>
              {lastFo.from}→{lastFo.to} {clock(lastFo.ts, timeFormat)}
            </Text>
            <Text dimColor>
              {lastFo.restoredAt
                ? ` · back ${clock(lastFo.restoredAt, timeFormat)}`
                : rl.modelRestoreAt
                  ? ` · back after ${clock(rl.modelRestoreAt, timeFormat)}`
                  : " · back: reset unknown"}
              {fo.length > 1 ? ` · ${fo.length} total` : ""}
            </Text>
          </>
        ) : (
          <Text dimColor>none</Text>
        )}
      </Row>
      <Row label="windows">
        5h {untilIso(rl.sessionResetAt, now)} · weekly {untilIso(rl.weeklyResetAt, now)}
      </Row>
      <Row label="weekly">
        <Text color={over ? "red" : undefined}>{bar(pct, 16)}</Text>
        {rl.weeklyStopPct != null ? <Text dimColor> stop @ {rl.weeklyStopPct}%</Text> : null}
      </Row>
      <Row label="caffeinate">
        {rl.caffeinatePid ? <Text color="green">active (pid {rl.caffeinatePid})</Text> : <Text dimColor>off</Text>}
      </Row>
    </Panel>
  );
}
