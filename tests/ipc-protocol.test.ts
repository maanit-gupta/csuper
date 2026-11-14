import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backoffDelay, fetchSnapshot, sendControl, SessionClient } from "../src/cli/client.js";
import { IpcServer } from "../src/ipc-server.js";
import { Logger } from "../src/logger.js";
import { encode, lineParser, validateClientMessage } from "../src/protocol.js";
import { applyPatch } from "../src/state.js";
import { sampleState, tmpHome } from "./fixtures.js";

let home: string;
let sock: string;
let server: IpcServer | null;

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** Raw NDJSON connection for low-level protocol checks. */
function raw(): Promise<{ sock: net.Socket; msgs: any[]; send: (m: unknown) => void }> {
  return new Promise((resolve) => {
    const s = net.createConnection(sock);
    const msgs: any[] = [];
    s.on("data", lineParser((m) => msgs.push(m)));
    s.on("connect", () => resolve({ sock: s, msgs, send: (m) => s.write(JSON.stringify(m) + "\n") }));
  });
}

beforeEach(async () => {
  home = tmpHome("csi-");
  sock = path.join(home, "sessions", "a1b2c3.sock");
});

afterEach(async () => {
  await server?.close();
  server = null;
  fs.rmSync(home, { recursive: true, force: true });
});

async function start(opts: Partial<ConstructorParameters<typeof IpcServer>[0]> = {}) {
  server = new IpcServer({ sockPath: sock, initialState: sampleState(), ...opts });
  await server.listen();
  return server;
}

describe("message validation", () => {
  it("accepts only allow-listed types and actions", () => {
    expect(validateClientMessage({ type: "subscribe", v: 1 }).ok).toBe(true);
    for (const a of ["autopilot.pause", "autopilot.resume", "countdown.cancel", "ratelimit.skip_wait"])
      expect(validateClientMessage({ type: "control", v: 1, action: a }).ok).toBe(true);
    expect(validateClientMessage({ type: "control", v: 1, action: "pty.write" })).toMatchObject({ ok: false, action: "pty.write" });
    expect(validateClientMessage({ type: "exec", cmd: "rm -rf /" }).ok).toBe(false);
    expect(validateClientMessage([1, 2]).ok).toBe(false);
    expect(validateClientMessage(null).ok).toBe(false);
  });

  it("splits NDJSON across chunk boundaries and survives bad lines", () => {
    const got: unknown[] = [];
    const errs: Error[] = [];
    const push = lineParser((m) => got.push(m), (e) => errs.push(e));
    push('{"a":1}\n{"b"');
    push(':2}\nnot-json\n\n{"c":3}\n');
    expect(got).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
    expect(errs).toHaveLength(1);
  });
});

describe("state patches", () => {
  it("merges objects, replaces arrays/null and editThrash wholesale", () => {
    const s = sampleState();
    const p = applyPatch(s, {
      rateLimit: { status: "waiting", resumeAt: "x" },
      countdown: null,
      triggers: { recent: [] },
      anomalies: { editThrash: { "b.ts": 1 } },
    });
    expect(p.rateLimit.status).toBe("waiting");
    expect(p.rateLimit.caffeinatePid).toBe(5150);
    expect(p.countdown).toBeNull();
    expect(p.triggers.recent).toEqual([]);
    expect(p.anomalies.editThrash).toEqual({ "b.ts": 1 });
    expect(p.anomalies.threshold).toBe(5);
    expect(s.rateLimit.status).toBe("ok"); // immutable
  });
});

describe("IPC server", () => {
  it("creates the socket with mode 0600", async () => {
    await start();
    expect(fs.statSync(sock).mode & 0o777).toBe(0o600);
  });

  it("sends a snapshot right after subscribe, then patches, events and logs", async () => {
    const logger = new Logger({ session: "a1b2c3", file: path.join(home, "a.jsonl") });
    const srv = await start({ logger });
    const c = await raw();
    c.send({ type: "subscribe", v: 1 });
    await until(() => c.msgs.length >= 1);
    expect(c.msgs[0]).toMatchObject({ type: "snapshot", v: 1, state: { session: { id: "a1b2c3" } } });

    srv.patchState({ autopilot: { enabled: false, pausedReason: "user" } });
    srv.emitEvent("trigger.matched", { trigger: "task_complete" });
    logger.info("command.injected", "/clear");
    await until(() => c.msgs.length >= 4);
    expect(c.msgs[1]).toMatchObject({ type: "event", event: "state.patch", data: { autopilot: { enabled: false } } });
    expect(c.msgs[2]).toMatchObject({ type: "event", event: "trigger.matched" });
    expect(c.msgs[3]).toMatchObject({ type: "log", line: { event: "command.injected", session: "a1b2c3" } });
    expect(srv.getState().autopilot.pausedReason).toBe("user");
    c.sock.destroy();
  });

  it("runs allow-listed controls through the handler and acks", async () => {
    const calls: string[] = [];
    await start({ onControl: (a) => (calls.push(a), { ok: true }) });
    const ack = await sendControl(sock, "autopilot.pause");
    expect(ack).toMatchObject({ type: "ack", action: "autopilot.pause", ok: true, error: null });
    expect(calls).toEqual(["autopilot.pause"]);
  });

  it("rejects non-allow-listed actions without calling the handler", async () => {
    const calls: string[] = [];
    await start({ onControl: (a) => (calls.push(a), { ok: true }) });
    const c = await raw();
    c.send({ type: "subscribe", v: 1 });
    c.send({ type: "control", v: 1, action: "pty.write", text: "rm -rf ~" });
    c.send({ type: "bogus" });
    await until(() => c.msgs.filter((m) => m.type === "ack").length >= 2);
    const acks = c.msgs.filter((m) => m.type === "ack");
    expect(acks[0]).toMatchObject({ ok: false, action: "pty.write" });
    expect(acks[0].error).toMatch(/not allowed/);
    expect(acks[1]).toMatchObject({ ok: false });
    expect(calls).toEqual([]);
    c.sock.destroy();
  });

  it("reports handler errors in the ack", async () => {
    await start({ onControl: () => ({ ok: false, error: "no countdown pending" }) });
    expect(await sendControl(sock, "countdown.cancel")).toMatchObject({ ok: false, error: "no countdown pending" });
    await server!.close();
    server = null;
    await start({ onControl: () => Promise.reject(new Error("boom")) });
    expect(await sendControl(sock, "countdown.cancel")).toMatchObject({ ok: false, error: "boom" });
  });

  it("routes hook messages (non-dashboard first message) to the hook handler", async () => {
    const hooks: unknown[] = [];
    await start({ onHookMessage: (m) => hooks.push(m) });
    const c = await raw();
    c.send({ hook: "PostToolUse", tool: "Edit", ok: false });
    c.send({ hook: "PostToolUse", tool: "Bash", ok: true });
    await until(() => hooks.length === 2);
    expect(c.msgs).toEqual([]); // hooks are fire-and-forget: no reply, never a snapshot
    c.sock.destroy();
  });

  it("drops a client that stops reading once its buffer overflows, without blocking", async () => {
    const srv = await start({ maxBufferedMsgs: 50 });
    const c = net.createConnection(sock);
    await new Promise((r) => c.on("connect", r));
    c.write(encode({ type: "subscribe", v: 1 }));
    await until(() => srv.subscriberCount === 1);
    c.pause(); // frozen dashboard

    const healthy = new SessionClient({ sockPath: sock });
    let healthyPatches = 0;
    healthy.on("state", () => healthyPatches++);
    healthy.start();
    await until(() => healthy.status === "connected");

    const big = "x".repeat(4096);
    const t0 = Date.now();
    for (let i = 0; i < 2000; i++) srv.emitEvent("trigger.matched", { pad: big, i });
    expect(Date.now() - t0).toBeLessThan(1000); // never blocks
    await until(() => srv.subscriberCount === 1); // frozen one dropped, healthy one kept
    srv.patchState({ model: "sonnet" });
    await until(() => healthy.state?.model === "sonnet");
    expect(healthyPatches).toBeGreaterThan(0);
    healthy.stop();
    c.destroy();
  });
});

describe("client", () => {
  it("computes capped exponential backoff", () => {
    expect([0, 1, 2, 3, 6, 10].map((n) => backoffDelay(n, 250, 10_000))).toEqual([250, 500, 1000, 2000, 10_000, 10_000]);
  });

  it("fetches one-shot snapshots", async () => {
    await start();
    const { state, v } = await fetchSnapshot(sock);
    expect(v).toBe(1);
    expect(state.session.id).toBe("a1b2c3");
  });

  it("fails fast on a missing socket", async () => {
    await expect(fetchSnapshot(path.join(home, "nope.sock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("shows DISCONNECTED, reconnects with backoff and refetches a snapshot", async () => {
    const srv = await start();
    const c = new SessionClient({ sockPath: sock, initialBackoffMs: 20, maxBackoffMs: 100 });
    const statuses: string[] = [];
    let snapshots = 0;
    c.on("status", (s) => statuses.push(s));
    c.on("snapshot", () => snapshots++);
    c.start();
    await until(() => c.status === "connected");
    srv.patchState({ cycles: { used: 7 } });
    await until(() => c.state?.cycles.used === 7);
    expect(c.state?.cycles.max).toBe(20);

    await srv.close();
    server = null;
    await until(() => c.status === "disconnected" || c.status === "connecting");
    expect(statuses).toContain("disconnected");

    server = new IpcServer({ sockPath: sock, initialState: sampleState({ model: "sonnet" }) });
    await server.listen();
    await until(() => c.status === "connected" && c.state?.model === "sonnet");
    expect(snapshots).toBe(2);
    const ack = await c.control("autopilot.resume");
    expect(ack.ok).toBe(false); // no handler on this daemon
    c.stop();
  });
});
