import type { LogRecord } from "./logger.js";
import type { DashState } from "./state.js";

/** Newline-delimited JSON protocol over the session socket (docs/dashboard-spec.md §6.2). */
export const PROTOCOL_VERSION = 1;

export const CONTROL_ACTIONS = ["autopilot.pause", "autopilot.resume", "countdown.cancel", "ratelimit.skip_wait"] as const;
export type ControlAction = (typeof CONTROL_ACTIONS)[number];

export type ClientMessage = { type: "subscribe"; v: number } | { type: "control"; v: number; action: ControlAction };

export type ServerMessage =
  | { type: "snapshot"; v: number; state: DashState }
  | { type: "event"; v: number; event: string; ts: string; data: Record<string, unknown> }
  | { type: "log"; v: number; line: LogRecord }
  | { type: "ack"; v: number; action: string | null; ok: boolean; error: string | null };

/** Max bytes buffered for a single unterminated line before the peer is considered broken. */
export const MAX_LINE_BYTES = 1_048_576;

export function isControlAction(a: unknown): a is ControlAction {
  return typeof a === "string" && (CONTROL_ACTIONS as readonly string[]).includes(a);
}

export type Validated =
  | { ok: true; msg: ClientMessage }
  | { ok: false; error: string; action: string | null };

/** Enforce the type/action allow-list. Anything else is rejected. */
export function validateClientMessage(raw: unknown): Validated {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "message must be a JSON object", action: null };
  const m = raw as Record<string, unknown>;
  if (m.type === "subscribe") return { ok: true, msg: { type: "subscribe", v: Number(m.v) || 0 } };
  if (m.type === "control") {
    const action = typeof m.action === "string" ? m.action : null;
    if (!isControlAction(m.action)) return { ok: false, error: `action not allowed: ${String(m.action)}`, action };
    return { ok: true, msg: { type: "control", v: Number(m.v) || 0, action: m.action } };
  }
  return { ok: false, error: `type not allowed: ${String(m.type)}`, action: null };
}

export function encode(msg: ServerMessage | ClientMessage): string {
  return JSON.stringify(msg) + "\n";
}

/**
 * Returns a `push(chunk)` function that splits incoming data on newlines and calls
 * `onLine` with each parsed JSON value (or `onError` for malformed lines).
 */
export function lineParser(onLine: (v: unknown) => void, onError?: (err: Error) => void): (chunk: Buffer | string) => void {
  let buf = "";
  return (chunk) => {
    buf += chunk.toString();
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let v: unknown;
      try {
        v = JSON.parse(line);
      } catch (e) {
        onError?.(e as Error);
        continue;
      }
      onLine(v);
    }
    if (buf.length > MAX_LINE_BYTES) {
      buf = "";
      onError?.(new Error("line too long"));
    }
  };
}
