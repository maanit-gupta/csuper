import { Text } from "ink";
import React from "react";
import type { DashState } from "../../state.js";
import { sinceIso, shortenHome } from "../format.js";
import { Panel, Row } from "./Panel.js";

export function GitPanel({
  state,
  now,
  focused,
  showHandover,
  handoverLines,
  handoverScroll,
  previewLines,
  height,
}: {
  state: DashState;
  now: number;
  focused: boolean;
  showHandover: boolean;
  /** null = file missing/unreadable. */
  handoverLines: string[] | null;
  handoverScroll: number;
  previewLines: number;
  height?: number;
}) {
  const cp = state.git.lastCheckpoint;
  const visible = handoverLines ? handoverLines.slice(handoverScroll, handoverScroll + previewLines) : [];
  const total = handoverLines?.length ?? 0;
  return (
    <Panel
      title="Git & Handover"
      index={5}
      focused={focused}
      flexGrow={1}
      height={height}
      right={showHandover && total > previewLines ? `${handoverScroll + 1}-${Math.min(total, handoverScroll + previewLines)}/${total} ↑↓` : undefined}
    >
      <Row label="checkpoint">
        {cp ? (
          <>
            <Text color="yellow">{cp.sha.slice(0, 7)}</Text> {sinceIso(cp.ts, now)} · {cp.files} file{cp.files === 1 ? "" : "s"}
          </>
        ) : (
          <Text dimColor>none yet</Text>
        )}
      </Row>
      <Row label="stashes">
        {state.git.stashes.length ? <Text color="yellow">{state.git.stashes.length}</Text> : <Text dimColor>0</Text>}
        {state.git.stashes.length ? <Text dimColor> {state.git.stashes[0]}</Text> : null}
      </Row>
      <Row label="handover">
        {shortenHome(state.handover.path)}
        <Text dimColor> {state.handover.mtime ? `modified ${sinceIso(state.handover.mtime, now)}` : "(not written)"}</Text>
      </Row>
      {showHandover ? (
        handoverLines === null ? (
          <Text dimColor>  (no handover.md)</Text>
        ) : (
          visible.map((l, i) => (
            <Text key={i} wrap="truncate">
              <Text dimColor>│ </Text>
              {l || " "}
            </Text>
          ))
        )
      ) : (
        <Text dimColor>  preview hidden (h)</Text>
      )}
    </Panel>
  );
}
