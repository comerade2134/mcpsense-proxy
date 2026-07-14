import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startCloudServer } from "../../src/cloud/cloud-server.js";
import { startRemoteLegacyFixture } from "../fixture-remote-legacy-server.js";
import { TenantRegistry } from "../../src/cloud/tenant-registry.js";
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
  srv = startCloudServer({ port: 0, registerKey: "rk", egressAllowlist: ["127.0.0.1"] });
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
    const text = await logsRes.text();
    const lines = text.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    expect(JSON.parse(lines[lines.length - 1]).method).toBe("tools/list");
    expect(logsRes.headers.get("content-type")).toContain("application/jsonl");
  });

  it("returns 200 with empty application/jsonl body for a tenant with no logs", async () => {
    const reg = await post("/register", { type: "remote", url: remote.url });
    const { endpoint, token } = await reg.json();
    const logsRes = await fetch(base + endpoint.replace("/mcp", "/logs"), {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(logsRes.status).toBe(200);
    expect(logsRes.headers.get("content-type")).toContain("application/jsonl");
    expect((await logsRes.text())).toBe("");
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

  it("blocks remote registration to non-allowed egress targets", async () => {
    const blocked = await post("/register", { type: "remote", url: "http://169.254.169.254/latest/meta-data" });
    expect(blocked.status).toBe(400);
    const ok = await post("/register", { type: "remote", url: "https://api.example.com/mcp" });
    expect(ok.status).toBe(200);
  });
});

describe("cloud server (paid mode)", () => {
  let paidSrv: Server;
  let paidBase: string;
  let reg: TenantRegistry;

  beforeAll(async () => {
    reg = new TenantRegistry("rk");
    paidSrv = startCloudServer({ port: 0, registerKey: "rk", stripeSecretKey: "sk_test_x", registry: reg });
    await new Promise<void>((r) => paidSrv.listen(0, r));
    paidBase = `http://127.0.0.1:${(paidSrv.address() as AddressInfo).port}`;
  });
  afterAll(() => paidSrv?.close());

  function paidPost(path: string, body: unknown, headers: Record<string, string> = {}) {
    return fetch(paidBase + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  }

  it("blocks bridging for an unpaid tenant with a checkout link (402)", async () => {
    const { record, token } = await reg.register({ type: "remote", url: remote.url }, "rk");
    const res = await paidPost(record.endpoint, { jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } } }, { "mcp-protocol-version": "2026-07-28", "mcp-method": "server/discover", authorization: `Bearer ${token}` });
    expect(res.status).toBe(402);
    const j = await res.json();
    expect(j.error).toBe("payment required");
    expect(j.checkout).toContain(`tenantId=${record.id}`);
  });

  it("allows bridging once the tenant is marked paid (200)", async () => {
    const { record, token } = await reg.register({ type: "remote", url: remote.url }, "rk");
    reg.setPaid(record.id, true);
    const res = await paidPost(record.endpoint, { jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } } }, { "mcp-protocol-version": "2026-07-28", "mcp-method": "server/discover", authorization: `Bearer ${token}` });
    expect(res.status).toBe(200);
    expect((await res.json()).result.serverInfo.name).toBe("fixture-remote-legacy");
  });

  it("blocks /logs for an unpaid tenant (402)", async () => {
    const { record, token } = await reg.register({ type: "remote", url: remote.url }, "rk");
    const res = await fetch(paidBase + record.endpoint.replace("/mcp", "/logs"), { method: "GET", headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(402);
  });
});

describe("cloud server (token rotation + disable)", () => {
  let rotSrv: Server;
  let rotBase: string;
  let reg: TenantRegistry;

  beforeAll(async () => {
    reg = new TenantRegistry("rk");
    rotSrv = startCloudServer({ port: 0, registerKey: "rk", registry: reg, egressAllowlist: ["127.0.0.1"] });
    await new Promise<void>((r) => rotSrv.listen(0, r));
    rotBase = `http://127.0.0.1:${(rotSrv.address() as AddressInfo).port}`;
  });
  afterAll(() => rotSrv?.close());

  function rotPost(path: string, body: unknown, headers: Record<string, string> = {}) {
    return fetch(rotBase + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  }

  it("rotates a tenant token and invalidates the old one", async () => {
    const regRes = await rotPost("/register", { type: "remote", url: remote.url });
    const { endpoint, token } = await regRes.json();
    const rot = await rotPost(endpoint.replace("/mcp", "/rotate"), {}, { authorization: `Bearer ${token}` });
    expect(rot.status).toBe(200);
    const newToken = (await rot.json()).token as string;
    expect(newToken).not.toBe(token);
    const oldUse = await rotPost(endpoint, { jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } } }, { "mcp-protocol-version": "2026-07-28", "mcp-method": "server/discover", authorization: `Bearer ${token}` });
    expect(oldUse.status).toBe(401);
    const newUse = await rotPost(endpoint, { jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } } }, { "mcp-protocol-version": "2026-07-28", "mcp-method": "server/discover", authorization: `Bearer ${newToken}` });
    expect(newUse.status).toBe(200);
  });

  it("rejects rotation with a bad token (401)", async () => {
    const regRes = await rotPost("/register", { type: "remote", url: remote.url });
    const { endpoint } = await regRes.json();
    const bad = await rotPost(endpoint.replace("/mcp", "/rotate"), {}, { authorization: "Bearer nope" });
    expect(bad.status).toBe(401);
  });

  it("blocks a disabled tenant on the bridge (403) and re-enables", async () => {
    const { record, token } = await reg.register({ type: "remote", url: remote.url }, "rk");
    const disc = (headers: Record<string, string>) =>
      rotPost(record.endpoint, { jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } } }, { "mcp-protocol-version": "2026-07-28", "mcp-method": "server/discover", ...headers });
    expect((await disc({ authorization: `Bearer ${token}` })).status).toBe(200);
    reg.setDisabled(record.id, true);
    expect((await disc({ authorization: `Bearer ${token}` })).status).toBe(403);
    reg.setDisabled(record.id, false);
    expect((await disc({ authorization: `Bearer ${token}` })).status).toBe(200);
  });
});
