import { EventEmitter } from "node:events";
import net from "node:net";
import type { LogRecord } from "../logger.js";
import {
  encode,
  lineParser,
  PROTOCOL_VERSION,
  type ControlAction,
  type ServerMessage,
} from "../protocol.js";
import { applyPatch, type DashState } from "../state.js";

export type ConnStatus = "connecting" | "connected" | "disconnected";
export type Ack = Extract<ServerMessage, { type: "ack" }>;

export interface SessionClientEvents {
  status: [ConnStatus];
  snapshot: [DashState];
  state: [DashState];
  event: [{ event: string; ts: string; data: Record<string, unknown> }];
  log: [LogRecord];
  ack: [Ack];
  versionMismatch: [number];
}

export interface SessionClientOptions {
  sockPath: string;
  maxBackoffMs?: number;
  initialBackoffMs?: number;
}

/** Exponential backoff: initial·2^attempt, capped. */
export function backoffDelay(attempt: number, initial = 250, max = 10_000): number {
  return Math.min(max, initial * 2 ** Math.max(0, attempt));
}

/**
 * Subscribing socket client used by the TUI. Keeps a merged copy of the state,
 * reconnects with exponential backoff and re-fetches a snapshot on reconnect.
 */
export class SessionClient extends EventEmitter<SessionClientEvents> {
  state: DashState | null = null;
  status: ConnStatus = "disconnected";
  private socket: net.Socket | null = null;
  private attempt = 0;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private pendingAcks: Array<{ action: ControlAction; resolve: (a: Ack) => void; timer: NodeJS.Timeout }> = [];

  constructor(private opts: SessionClientOptions) {
    super();
  }

  get sockPath(): string {
    return this.opts.sockPath;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.socket?.destroy();
    this.socket = null;
    this.failPending("client stopped");
  }

  /** Point the client at another session (session switcher). */
  switchTo(sockPath: string): void {
    this.stop();
    this.opts.sockPath = sockPath;
    this.state = null;
    this.attempt = 0;
    this.start();
  }

  /** Send an allow-listed control action and wait for its ack. */
  control(action: ControlAction, timeoutMs = 5000): Promise<Ack> {
    return new Promise((resolve) => {
      if (!this.socket || this.status !== "connected") {
        return resolve({ type: "ack", v: PROTOCOL_VERSION, action, ok: false, error: "not connected" });
      }
      const timer = setTimeout(() => {
        this.pendingAcks = this.pendingAcks.filter((p) => p.timer !== timer);
        resolve({ type: "ack", v: PROTOCOL_VERSION, action, ok: false, error: "timed out waiting for ack" });
      }, timeoutMs);
      this.pendingAcks.push({ action, resolve, timer });
      this.socket.write(encode({ type: "control", v: PROTOCOL_VERSION, action }));
    });
  }

  private setStatus(s: ConnStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.emit("status", s);
  }

  private connect(): void {
    if (this.stopped) return;
    this.setStatus("connecting");
    const sock = net.createConnection(this.opts.sockPath);
    this.socket = sock;
    sock.on("connect", () => {
      sock.write(encode({ type: "subscribe", v: PROTOCOL_VERSION }));
    });
    sock.on("data", lineParser((m) => this.onMessage(m as ServerMessage)));
    sock.on("error", () => {
      /* handled by close */
    });
    sock.on("close", () => {
      if (this.socket !== sock) return;
      this.socket = null;
      this.failPending("disconnected");
      this.setStatus("disconnected");
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = backoffDelay(this.attempt++, this.opts.initialBackoffMs ?? 250, this.opts.maxBackoffMs ?? 10_000);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }

  private failPending(error: string): void {
    for (const p of this.pendingAcks.splice(0)) {
      clearTimeout(p.timer);
      p.resolve({ type: "ack", v: PROTOCOL_VERSION, action: p.action, ok: false, error });
    }
  }

  private onMessage(m: ServerMessage): void {
    if (!m || typeof m !== "object") return;
    if (typeof m.v === "number" && m.v !== PROTOCOL_VERSION) this.emit("versionMismatch", m.v);
    switch (m.type) {
      case "snapshot":
        this.attempt = 0;
        this.state = m.state;
        this.setStatus("connected");
        this.emit("snapshot", m.state);
        this.emit("state", m.state);
        break;
      case "event":
        if (m.event === "state.patch") {
          if (this.state) {
            this.state = applyPatch(this.state, m.data);
            this.emit("state", this.state);
          }
        } else {
          this.emit("event", { event: m.event, ts: m.ts, data: m.data });
        }
        break;
      case "log":
        this.emit("log", m.line);
        break;
      case "ack": {
        const i = this.pendingAcks.findIndex((p) => p.action === m.action);
        if (i >= 0) {
          const [p] = this.pendingAcks.splice(i, 1);
          clearTimeout(p.timer);
          p.resolve(m);
        }
        this.emit("ack", m);
        break;
      }
    }
  }
}

function oneShot<T>(sockPath: string, first: string, pick: (m: ServerMessage) => T | undefined, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(sockPath);
    let done = false;
    const finish = (err: Error | null, v?: T) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      err ? reject(err) : resolve(v as T);
    };
    const timer = setTimeout(() => finish(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })), timeoutMs);
    sock.on("connect", () => sock.write(first));
    sock.on(
      "data",
      lineParser((m) => {
        const v = pick(m as ServerMessage);
        if (v !== undefined) finish(null, v);
      }),
    );
    sock.on("error", (e) => finish(e));
    sock.on("close", () => finish(Object.assign(new Error("connection closed"), { code: "ECONNRESET" })));
  });
}

/** Subscribe, take the snapshot, disconnect. */
export function fetchSnapshot(sockPath: string, timeoutMs = 2000): Promise<{ state: DashState; v: number }> {
  return oneShot(
    sockPath,
    encode({ type: "subscribe", v: PROTOCOL_VERSION }),
    (m) => (m.type === "snapshot" ? { state: m.state, v: m.v } : undefined),
    timeoutMs,
  );
}

/** Send one control action and return its ack. */
export function sendControl(sockPath: string, action: ControlAction, timeoutMs = 5000): Promise<Ack> {
  return oneShot(
    sockPath,
    encode({ type: "control", v: PROTOCOL_VERSION, action }),
    (m) => (m.type === "ack" ? m : undefined),
    timeoutMs,
  );
}
