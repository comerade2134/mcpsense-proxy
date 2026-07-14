import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { LegacyClientManager } from "../src/legacy-client.js";
import { RemoteHttpClientTransport } from "../src/remote-http-transport.js";
import { createProxyHandler } from "../src/proxy-server.js";
import { startRemoteLegacyFixture } from "./fixture-remote-legacy-server.js";

const fixture = fileURLToPath(new URL("./fixture-legacy-server.ts", import.meta.url));

let manager: LegacyClientManager;
let server: ReturnType<typeof createServer>;
let base: string;

beforeAll(async () => {
  manager = new LegacyClientManager(new StdioClientTransport({ command: "npx", args: ["tsx", fixture] }));
  await manager.bootstrap();
  server = createServer(createProxyHandler(manager));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}/mcp`;
}, 30_000);

afterAll(() => {
  server?.close();
});

// --- Phase 4: remote stateful HTTP backend ---
let remoteManager: LegacyClientManager;
let remoteProxy: ReturnType<typeof createServer>;
let remoteBase: string;
let remoteFixture: Awaited<ReturnType<typeof startRemoteLegacyFixture>>;

beforeAll(async () => {
  remoteFixture = await startRemoteLegacyFixture();
  remoteManager = new LegacyClientManager(new RemoteHttpClientTransport(remoteFixture.url));
  await remoteManager.bootstrap();
  remoteProxy = createServer(createProxyHandler(remoteManager));
  await new Promise<void>((resolve) => remoteProxy.listen(0, resolve));
  const addr = remoteProxy.address() as AddressInfo;
  remoteBase = `http://127.0.0.1:${addr.port}/mcp`;
}, 30_000);

afterAll(() => {
  remoteProxy?.close();
  remoteFixture?.server.close();
});

async function post(body: unknown, headers: Record<string, string> = {}) {
  return fetch(base, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-protocol-version": "2026-07-28",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const DISCOVER_META = {
  _meta: {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "test-client", version: "1.0.0" },
    "io.modelcontextprotocol/clientCapabilities": {},
  },
};

describe("mcpsense-proxy", () => {
  it("answers server/discover with the 2026-07-28 version", async () => {
    const res = await post(
      { jsonrpc: "2.0", id: 1, method: "server/discover", params: DISCOVER_META },
      { "mcp-method": "server/discover" },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-method")).toBe("server/discover");
    const json = await res.json();
    expect(json.result.supportedVersions).toContain("2026-07-28");
  });

  it("lists and calls the legacy greet tool transparently", async () => {
    const list = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, { "mcp-method": "tools/list" });
    const lj = await list.json();
    expect(lj.result.tools.find((t: { name: string }) => t.name === "greet")).toBeTruthy();

    const call = await post(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "greet", arguments: { name: "LO" } } },
      { "mcp-method": "tools/call", "mcp-name": "greet" },
    );
    const cj = await call.json();
    expect(JSON.stringify(cj.result.content)).toContain("Hello, LO!");
  });

  it("rejects a missing Mcp-Method header with 400 / -32001", async () => {
    const res = await post({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32001);
  });

  it("rejects a Mcp-Method / body mismatch with 400 / -32001", async () => {
    const res = await post(
      { jsonrpc: "2.0", id: 5, method: "tools/list", params: {} },
      { "mcp-method": "tools/call" },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32001);
  });

  it("rejects a missing Mcp-Name on tools/call with 400 / -32001", async () => {
    const res = await post(
      { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "greet", arguments: {} } },
      { "mcp-method": "tools/call" },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32001);
  });
});

describe("mcpsense-proxy (remote legacy HTTP backend)", () => {
  async function rpost(body: unknown, headers: Record<string, string> = {}) {
    return fetch(remoteBase, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "mcp-protocol-version": "2026-07-28",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  }

  it("performs the legacy initialize handshake against the remote backend", async () => {
    expect(remoteManager.getMeta().serverInfo?.name).toBe("fixture-remote-legacy");
  });

  it("lists and calls the remote greet tool transparently", async () => {
    const list = await rpost({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, { "mcp-method": "tools/list" });
    const lj = await list.json();
    expect(lj.result.tools.find((t: { name: string }) => t.name === "greet")).toBeTruthy();

    const call = await rpost(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "greet", arguments: { name: "LO" } } },
      { "mcp-method": "tools/call", "mcp-name": "greet" },
    );
    const cj = await call.json();
    expect(JSON.stringify(cj.result.content)).toContain("Hello, LO!");
  });

  it("answers server/discover for the remote backend", async () => {
    const res = await rpost(
      { jsonrpc: "2.0", id: 4, method: "server/discover", params: DISCOVER_META },
      { "mcp-method": "server/discover" },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).result.supportedVersions).toContain("2026-07-28");
  });
});
