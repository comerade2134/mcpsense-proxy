import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startCloudServer } from "../../src/cloud/cloud-server.js";
import { startRemoteLegacyFixture } from "../fixture-remote-legacy-server.js";
import { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { existsSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";

let srv: Server;
let base: string;
let remote: Awaited<ReturnType<typeof startRemoteLegacyFixture>>;
let dataDir: string;

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  dataDir = join(process.cwd(), "data");
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  remote = await startRemoteLegacyFixture();
  srv = startCloudServer({ port: 0, registerKey: "rk" });
  await new Promise<void>((r) => srv.listen(0, r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});

afterAll(() => {
  srv?.close();
  remote?.server.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("cloud server", () => {
  it("registers a remote backend and bridges it with a token", async () => {
    const reg = await post("/register", { type: "remote", url: remote.url });
    const rj = await reg.json();
    expect(rj.endpoint).toMatch(/^\/t\//);
    const token = rj.token;

    const disc = await post(rj.endpoint, { jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } } }, { "mcp-protocol-version": "2026-07-28", "mcp-method": "server/discover", authorization: `Bearer ${token}` });
    expect(disc.status).toBe(200);
    expect((await disc.json()).result.serverInfo.name).toBe("fixture-remote-legacy");

    const bad = await post(rj.endpoint, { jsonrpc: "2.0", id: 1, method: "server/discover", params: {} }, { "mcp-method": "server/discover", authorization: "Bearer nope" });
    expect(bad.status).toBe(401);
  });

  it("rejects stdio register without key (403) and allows with key", async () => {
    const noKey = await post("/register", { type: "stdio", command: "echo", args: ["x"] });
    expect(noKey.status).toBe(403);
    const withKey = await post("/register", { type: "stdio", command: "echo", args: ["x"] }, { "x-register-key": "rk" });
    expect(withKey.status).toBe(200);
  });

  it("records request logs retrievable via /logs", async () => {
    const reg = await post("/register", { type: "remote", url: remote.url });
    const { endpoint, token } = await reg.json();
    await post(endpoint, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list", authorization: `Bearer ${token}` });
    if (!existsSync(join(dataDir, "logs"))) mkdirSync(join(dataDir, "logs"), { recursive: true });
    const logsRes = await fetch(base + endpoint.replace("/mcp", "/logs"), {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
    });
    const lj = await logsRes.json();
    expect(lj.logs.length).toBeGreaterThan(0);
    expect(lj.logs[lj.logs.length - 1].method).toBe("tools/list");
  });

  it("health endpoint", async () => {
    const h = await fetch(base + "/health");
    expect(h.status).toBe(200);
  });

  it("rejects malformed JSON with 400", async () => {
    const res = await fetch(base + "/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("rejects /logs without a valid token (401)", async () => {
    const reg = await post("/register", { type: "remote", url: remote.url });
    const { endpoint } = await reg.json();
    const res = await fetch(base + endpoint.replace("/mcp", "/logs"), { method: "GET" });
    expect(res.status).toBe(401);
  });

  it("returns 404 for unknown tenant", async () => {
    const res = await fetch(base + "/t/t_unknown/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer x" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover", params: {} }),
    });
    expect(res.status).toBe(404);
  });
});
