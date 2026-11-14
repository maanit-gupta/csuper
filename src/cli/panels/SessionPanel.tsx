import { Text } from "ink";
import React from "react";
import type { DashState } from "../../state.js";
import { autopilotLabel, formatDuration, shortenHome } from "../format.js";
import { Panel, Row } from "./Panel.js";

const AP_COLOR = { ON: "green", OFF: "gray", PAUSED: "yellow" } as const;

export function SessionPanel({ state, now, focused, height }: { state: DashState; now: number; focused: boolean; height?: number }) {
  const s = state;
  const ap = autopilotLabel(s);
  const cyclesHit = s.cycles.max > 0 && s.cycles.used >= s.cycles.max;
  return (
    <Panel title="Session & Autopilot" index={1} focused={focused} flexGrow={1} height={height}>
      <Row label="session">
        <Text bold>{s.session.id}</Text>
        <Text dimColor> v{s.session.version}</Text>
      </Row>
      <Row label="project">{shortenHome(s.session.cwd)}</Row>
      {s.session.adoptedFrom ? (
        <Row label="origin">
          <Text color="magenta">adopted from {s.session.adoptedFrom.slice(0, 8)}</Text>
        </Row>
      ) : null}
      <Row label="autopilot">
        <Text color={AP_COLOR[ap]} bold>
          {ap}
        </Text>
        {s.autopilot.pausedReason ? <Text color="yellow"> ({s.autopilot.pausedReason})</Text> : null}
      </Row>
      <Row label="model">
        <Text color={s.rateLimit.status === "failover" ? "yellow" : undefined}>{s.model}</Text>
      </Row>
      <Row label="cycles">
        <Text color={cyclesHit ? "red" : undefined}>
          {s.cycles.used} / {s.cycles.max || "∞"}
        </Text>
        {s.cycles.failed ? <Text color="red"> · {s.cycles.failed} failed</Text> : null}
      </Row>
      <Row label="active hrs">
        {s.activeHours.window} <Text color={s.activeHours.inside ? "green" : "yellow"}>({s.activeHours.inside ? "inside" : "outside"})</Text>
      </Row>
      <Row label="uptime">{formatDuration(now - Date.parse(s.session.startedAt))}</Row>
      <Row label="pids">
        csuper {s.session.pid} · claude {s.session.claudePid}
      </Row>
    </Panel>
  );
}
