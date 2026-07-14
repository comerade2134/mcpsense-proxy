// Standalone smoke test: runs the BUILT binary (bin/mcpsense-proxy.js) and hits
// it with real 2026-07-28 stateless requests. No vitest, no tsx in the path for
// the proxy itself — this validates the shipped artifact.
//
//   node test/smoke.mjs
//
import { spawn } from "node:child_process";
import { createServer } from "node:http";

const PROXY = "bin/mcpsense-proxy.js";
const FUNCS = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("•", ...a);

function startProxy(args, label) {
  const child = spawn("node", [PROXY, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => process.stdout.write(`  [${label}] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`  [${label}/err] ${d}`));
  return child;
}

async function waitReady(port, tries = 50) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", "mcp-protocol-version": "2026-07-28", "mcp-method": "server/discover" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "server/discover", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } } }),
      });
      if (r.status === 200) return true;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  throw new Error(`proxy on :${port} did not become ready`);
}

async function post(base, body, headers = {}) {
  const res = await fetch(base, {
    method: "POST",
    headers: { "content-type": "application/json", "mcp-protocol-version": "2026-07-28", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, mcpMethod: res.headers.get("mcp-method"), json: text ? JSON.parse(text) : null };
}

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

// --- A minimal remote, stateful legacy HTTP server (requires Mcp-Session-Id) ---
function startRemoteLegacy() {
  const sessions = new Set();
  let n = 0;
  const server = createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0];
    if (url !== "/mcp") return res.writeHead(404).end();
    if (req.method === "GET") {
      const sid = req.headers["mcp-session-id"];
      if (typeof sid !== "string" || !sessions.has(sid)) return res.writeHead(400).end();
      return res.writeHead(200, { "Content-Type": "text/event-stream" }).end();
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const msg = JSON.parse(Buffer.concat(chunks).toString());
      if (msg.method === "initialize") {
        const sid = `rsess-${n++}`;
        sessions.add(sid);
        res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": sid });
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "remote-legacy", version: "9.9.9" } } }));
      }
      const sid = req.headers["mcp-session-id"];
      if (typeof sid !== "string" || !sessions.has(sid)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "no session" } }));
      }
      if (msg.method === "tools/list") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "remote_greet", description: "greet remote", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } }] } }));
      }
      if (msg.method === "tools/call") {
        const name = (msg.params?.arguments ?? {}).name ?? "stranger";
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `Remote hello, ${name}!` }] } }));
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "nope" } }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port })));
}

async function run() {
  // ===== BACKEND A: local stdio legacy server (MVP) =====
  console.log("\n=== BACKEND A: local stdio legacy server ===");
  const aPort = 8091;
  const a = startProxy(["--host", "127.0.0.1", "--port", String(aPort), "--", "npx", "tsx", "test/fixture-legacy-server.ts"], "A");
  FUNCS.push(() => a.kill());
  await waitReady(aPort);
  const aBase = `http://127.0.0.1:${aPort}/mcp`;

  let r = await post(aBase, { jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } } }, { "mcp-method": "server/discover" });
  assert(r.status === 200 && r.json.result.supportedVersions.includes("2026-07-28"), "server/discover returns 2026-07-28");
  assert(r.mcpMethod === "server/discover", "Mcp-Method echo header present");

  r = await post(aBase, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, { "mcp-method": "tools/list" });
  assert(r.json.result.tools.some((t) => t.name === "greet"), "tools/list shows real 'greet' tool (transparent names)");

  r = await post(aBase, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "greet", arguments: { name: "LO" } } }, { "mcp-method": "tools/call", "mcp-name": "greet" });
  assert(JSON.stringify(r.json.result.content).includes("Hello, LO!"), "tools/call greet -> 'Hello, LO!'");

  r = await post(aBase, { jsonrpc: "2.0", id: 4, method: "tools/list", params: {} });
  assert(r.status === 400 && r.json.error.code === -32001, "missing Mcp-Method rejected with 400/-32001");

  a.kill();
  log("backend A OK\n");

  // ===== BACKEND B: remote stateful HTTP legacy server (Phase 4) =====
  console.log("\n=== BACKEND B: remote HTTP legacy server (--remote) ===");
  const remote = await startRemoteLegacy();
  FUNCS.push(() => remote.server.close());
  const bPort = 8092;
  const b = startProxy(["--host", "127.0.0.1", "--port", String(bPort), "--remote", `http://127.0.0.1:${remote.port}/mcp`], "B");
  FUNCS.push(() => b.kill());
  await waitReady(bPort);
  const bBase = `http://127.0.0.1:${bPort}/mcp`;

  r = await post(bBase, { jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } } }, { "mcp-method": "server/discover" });
  assert(r.status === 200 && r.json.result.serverInfo.name === "remote-legacy", "server/discover reflects REMOTE backend name");

  r = await post(bBase, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, { "mcp-method": "tools/list" });
  assert(r.json.result.tools.some((t) => t.name === "remote_greet"), "remote tools/list bridged through session");

  r = await post(bBase, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "remote_greet", arguments: { name: "LO" } } }, { "mcp-method": "tools/call", "mcp-name": "remote_greet" });
  assert(JSON.stringify(r.json.result.content).includes("Remote hello, LO!"), "remote tools/call -> 'Remote hello, LO!'");

  b.kill();
  remote.server.close();
  log("backend B OK\n");

  console.log("\n✅ SMOKE TEST PASSED — both backends bridge to 2026-07-28 clients.\n");
}

run()
  .catch((e) => {
    console.error("\n❌ SMOKE TEST FAILED:", e.message);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const f of FUNCS) {
      try {
        f();
      } catch {
        /* ignore */
      }
    }
  });
