import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { localIsoString, type Logger, type LogRecord } from "./logger.js";
import { ensurePrivateDir } from "./paths.js";
import {
  encode,
  lineParser,
  PROTOCOL_VERSION,
  validateClientMessage,
  type ControlAction,
  type ServerMessage,
} from "./protocol.js";
import { applyPatch, type DashState, type DeepPartial } from "./state.js";

export type ControlResult = { ok: boolean; error?: string | null };
export type ControlHandler = (action: ControlAction) => ControlResult | Promise<ControlResult>;

export interface IpcServerOptions {
  sockPath: string;
  initialState: DashState;
  /** Executes allow-listed control actions. The daemon is the only party that touches the PTY. */
  onControl?: ControlHandler;
  /** Fire-and-forget messages from hook scripts (connections whose first message isn't subscribe/control). */
  onHookMessage?: (msg: unknown) => void;
  /** If given, every log record is fanned out to subscribers and control requests are logged. */
  logger?: Logger;
  /** Per-subscriber bounded buffer; the client is dropped when it overflows. */
  maxBufferedMsgs?: number;
}

type Role = "unknown" | "subscriber" | "control" | "hook";

/** One dashboard connection. Writes never block the daemon. */
class Peer {
  role: Role = "unknown";
  private queue: string[] = [];
  private waiting = false;
  dropped = false;

  constructor(
    readonly socket: net.Socket,
    private maxBuffered: number,
    private onDrop: (p: Peer) => void,
  ) {}

  send(msg: ServerMessage): void {
    if (this.dropped || this.socket.destroyed) return;
    const line = encode(msg);
    if (this.waiting) {
      this.queue.push(line);
      if (this.queue.length > this.maxBuffered) this.drop();
      return;
    }
    if (!this.socket.write(line)) this.waitForDrain();
  }

  get buffered(): number {
    return this.queue.length;
  }

  private waitForDrain(): void {
    this.waiting = true;
    this.socket.once("drain", () => this.flush());
  }

  private flush(): void {
    this.waiting = false;
    while (this.queue.length && !this.dropped) {
      const line = this.queue.shift()!;
      if (!this.socket.write(line)) return this.waitForDrain();
    }
  }

  drop(): void {
    if (this.dropped) return;
    this.dropped = true;
    this.queue = [];
    this.socket.destroy();
    this.onDrop(this);
  }
}

/**
 * Session IPC server: snapshot + state.patch fan-out to dashboards, allow-listed
 * control actions, and pass-through of hook messages on the same socket.
 */
export class IpcServer {
  private server: net.Server;
  private peers = new Set<Peer>();
  private state: DashState;
  private opts: Required<Pick<IpcServerOptions, "maxBufferedMsgs">> & IpcServerOptions;
  private unsubscribeLog?: () => void;

  constructor(opts: IpcServerOptions) {
    this.opts = { maxBufferedMsgs: 1000, ...opts };
    this.state = opts.initialState;
    this.server = net.createServer((s) => this.onConnection(s));
    this.server.on("error", () => {
      /* never crash the supervisor */
    });
    if (opts.logger) this.unsubscribeLog = opts.logger.onRecord((r) => this.publishLog(r));
  }

  /** Start listening; removes a leftover socket file and sets mode 0600. */
  listen(): Promise<void> {
    const { sockPath } = this.opts;
    if (Buffer.byteLength(sockPath) > 103) {
      return Promise.reject(new Error(`socket path too long for macOS (${Buffer.byteLength(sockPath)} > 103 bytes): ${sockPath}; use a shorter CSUPER_HOME`));
    }
    ensurePrivateDir(path.dirname(sockPath));
    try {
      fs.unlinkSync(sockPath);
    } catch {
      /* not there */
    }
    return new Promise((resolve, reject) => {
      const onErr = (e: Error) => reject(e);
      this.server.once("error", onErr);
      this.server.listen(sockPath, () => {
        this.server.off("error", onErr);
        fs.chmodSync(sockPath, 0o600);
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    this.unsubscribeLog?.();
    for (const p of this.peers) p.socket.destroy();
    this.peers.clear();
    await new Promise<void>((r) => this.server.close(() => r()));
    try {
      fs.unlinkSync(this.opts.sockPath);
    } catch {
      /* already gone */
    }
  }

  /** Snapshot builder: the full current state. */
  getState(): DashState {
    return this.state;
  }

  setControlHandler(fn: ControlHandler): void {
    this.opts.onControl = fn;
  }

  /** Merge a partial state and broadcast it as a `state.patch` event. */
  patchState(patch: DeepPartial<DashState>): void {
    this.state = applyPatch(this.state, patch);
    this.broadcast({ type: "event", v: PROTOCOL_VERSION, event: "state.patch", ts: localIsoString(), data: patch as Record<string, unknown> });
  }

  /** Broadcast a domain event (trigger.matched, anomaly.detected, …). */
  emitEvent(event: string, data: Record<string, unknown> = {}): void {
    this.broadcast({ type: "event", v: PROTOCOL_VERSION, event, ts: localIsoString(), data });
  }

  publishLog(line: LogRecord): void {
    this.broadcast({ type: "log", v: PROTOCOL_VERSION, line });
  }

  get subscriberCount(): number {
    return [...this.peers].filter((p) => p.role === "subscriber").length;
  }

  private broadcast(msg: ServerMessage): void {
    for (const p of this.peers) if (p.role === "subscriber") p.send(msg);
  }

  private onConnection(socket: net.Socket): void {
    const peer = new Peer(socket, this.opts.maxBufferedMsgs, (p) => {
      this.peers.delete(p);
      this.opts.logger?.warn("ipc.client_dropped", "dashboard client dropped: send buffer overflow", { buffered: this.opts.maxBufferedMsgs });
    });
    this.peers.add(peer);
    socket.setNoDelay?.(true);
    const cleanup = () => this.peers.delete(peer);
    socket.on("close", cleanup);
    socket.on("error", cleanup);
    socket.on(
      "data",
      lineParser(
        (msg) => this.onMessage(peer, msg),
        (err) => {
          if (peer.role !== "hook") peer.send({ type: "ack", v: PROTOCOL_VERSION, action: null, ok: false, error: `bad message: ${err.message}` });
        },
      ),
    );
  }

  private onMessage(peer: Peer, raw: unknown): void {
    if (peer.role === "hook") return this.forwardHook(raw);
    const v = validateClientMessage(raw);
    if (peer.role === "unknown") {
      // The first message tells dashboards apart from hook scripts.
      if (!v.ok && !isDashboardType(raw)) {
        peer.role = "hook";
        return this.forwardHook(raw);
      }
      if (v.ok && v.msg.type === "subscribe") peer.role = "subscriber";
      else peer.role = "control";
    }
    if (!v.ok) {
      this.opts.logger?.warn("control.received", `rejected message: ${v.error}`);
      return peer.send({ type: "ack", v: PROTOCOL_VERSION, action: v.action, ok: false, error: v.error });
    }
    if (v.msg.type === "subscribe") {
      peer.role = "subscriber";
      return peer.send({ type: "snapshot", v: PROTOCOL_VERSION, state: this.state });
    }
    void this.runControl(peer, v.msg.action);
  }

  private async runControl(peer: Peer, action: ControlAction): Promise<void> {
    this.opts.logger?.info("control.received", `control: ${action}`, { action });
    let res: ControlResult;
    try {
      res = this.opts.onControl ? await this.opts.onControl(action) : { ok: false, error: "control not supported by this daemon" };
    } catch (e) {
      res = { ok: false, error: (e as Error).message };
    }
    peer.send({ type: "ack", v: PROTOCOL_VERSION, action, ok: res.ok, error: res.ok ? null : (res.error ?? "failed") });
  }

  private forwardHook(msg: unknown): void {
    try {
      this.opts.onHookMessage?.(msg);
    } catch (e) {
      this.opts.logger?.error("hook.error", `hook handler failed: ${(e as Error).message}`);
    }
  }
}

function isDashboardType(raw: unknown): boolean {
  const t = (raw as { type?: unknown } | null)?.type;
  return t === "subscribe" || t === "control";
}
