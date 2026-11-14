import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isValidSessionId,
  listSessions,
  newSessionId,
  pruneStale,
  readSessionInfo,
  removeSession,
  resolveSession,
  sockPathFor,
  writeSessionInfo,
  type SessionInfo,
} from "../src/session-registry.js";

let home: string;
let dir: string;
const servers: net.Server[] = [];

function info(id: string, pid = process.pid): SessionInfo {
  return { id, pid, claude_pid: pid, cwd: "/tmp/proj", started_at: new Date().toISOString(), config_path: null, version: "0.1.0" };
}

function listen(id: string): Promise<void> {
  return new Promise((resolve) => {
    const srv = net.createServer((s) => s.end());
    servers.push(srv);
    srv.listen(sockPathFor(id, dir), () => resolve());
  });
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "csr-"));
  dir = path.join(home, "sessions");
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))));
  fs.rmSync(home, { recursive: true, force: true });
});

describe("session registry", () => {
  it("generates 6-char hex ids", () => {
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 20; i++) expect(isValidSessionId(newSessionId(dir))).toBe(true);
    expect(isValidSessionId("xyz")).toBe(false);
  });

  it("writes session json with owner-only perms and dirs with 0700", () => {
    writeSessionInfo(info("a1b2c3"), dir);
    expect(readSessionInfo("a1b2c3", dir)?.cwd).toBe("/tmp/proj");
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(home).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(dir, "a1b2c3.json")).mode & 0o777).toBe(0o600);
  });

  it("classifies live and stale sessions", async () => {
    writeSessionInfo(info("aaaaaa"), dir);
    await listen("aaaaaa");
    writeSessionInfo(info("bbbbbb"), dir); // no socket → ENOENT
    writeSessionInfo(info("cccccc", 999_999), dir); // dead pid
    await listen("cccccc");
    const s = await listSessions(dir);
    const byId = Object.fromEntries(s.map((x) => [x.id, x]));
    expect(byId.aaaaaa.status).toBe("live");
    expect(byId.bbbbbb.status).toBe("stale");
    expect(byId.bbbbbb.staleReason).toMatch(/ENOENT/);
    expect(byId.cccccc.status).toBe("stale");
    expect(byId.cccccc.staleReason).toMatch(/pid/);
  });

  it("treats a leftover socket file with no listener as stale", async () => {
    writeSessionInfo(info("dddddd"), dir);
    // A crashed daemon leaves the path behind with nothing listening
    fs.writeFileSync(sockPathFor("dddddd", dir), "");
    const [s] = await listSessions(dir);
    expect(s.status).toBe("stale");
    expect(s.staleReason).toMatch(/socket/);
  });

  it("prunes only stale sessions", async () => {
    writeSessionInfo(info("aaaaaa"), dir);
    await listen("aaaaaa");
    writeSessionInfo(info("bbbbbb"), dir);
    expect(await pruneStale(dir)).toEqual(["bbbbbb"]);
    expect(fs.existsSync(path.join(dir, "bbbbbb.json"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "aaaaaa.json"))).toBe(true);
  });

  it("removeSession deletes sock and json and tolerates missing files", () => {
    writeSessionInfo(info("eeeeee"), dir);
    removeSession("eeeeee", dir);
    removeSession("eeeeee", dir);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("resolves one live session, reports ambiguity and not-found", async () => {
    delete process.env.CSUPER_SESSION;
    expect((await resolveSession(undefined, dir)).kind).toBe("not_found");
    writeSessionInfo(info("aaaaaa"), dir);
    await listen("aaaaaa");
    writeSessionInfo(info("bbbbbb"), dir); // stale — ignored for implicit selection
    const one = await resolveSession(undefined, dir);
    expect(one.kind === "ok" && one.session.id).toBe("aaaaaa");
    writeSessionInfo(info("cccccc"), dir);
    await listen("cccccc");
    expect((await resolveSession(undefined, dir)).kind).toBe("ambiguous");
    const explicit = await resolveSession("bbbbbb", dir);
    expect(explicit.kind === "ok" && explicit.session.status).toBe("stale");
    expect((await resolveSession("ffffff", dir)).kind).toBe("not_found");
    process.env.CSUPER_SESSION = "cccccc";
    const env = await resolveSession(undefined, dir);
    expect(env.kind === "ok" && env.session.id).toBe("cccccc");
    delete process.env.CSUPER_SESSION;
  });
});
