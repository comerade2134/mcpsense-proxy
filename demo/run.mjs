// One-command manual demo: starts the built proxy with the demo legacy server,
// runs the three example 2026-07-28 requests, prints them, and shuts down.
//
//   npm run demo
//
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROXY = join(ROOT, "bin", "mcpsense-proxy.js");
const LEGACY = join(ROOT, "demo", "legacy-server.mjs");
const PORT = 8080;
const BASE = `http://127.0.0.1:${PORT}/mcp`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const proxy = spawn("node", [PROXY, "--host", "127.0.0.1", "--port", String(PORT), "--", "node", LEGACY], {
  cwd: ROOT,
  stdio: ["ignore", "ignore", "inherit"],
});

async function waitReady() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(BASE, {
        method: "POST",
        headers: { "content-type": "application/json", "mcp-protocol-version": "2026-07-28", "mcp-method": "server/discover" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "server/discover", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } } }),
      });
      if (r.status === 200) return;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  throw new Error("proxy did not become ready");
}

async function call(label, headers, body) {
  console.log(`\n$ ${label}`);
  const res = await fetch(BASE, {
    method: "POST",
    headers: { "content-type": "application/json", "mcp-protocol-version": "2026-07-28", ...headers },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  console.log(JSON.stringify(json, null, 2));
}

async function main() {
  console.log(`Starting mcpsense-proxy on ${BASE} (bridging demo/legacy-server.mjs)...`);
  await waitReady();
  console.log("Proxy is up. Running example 2026-07-28 requests:\n");

  await call("server/discover", { "mcp-method": "server/discover" }, {
    jsonrpc: "2.0", id: 1, method: "server/discover",
    params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } },
  });

  await call("tools/list", { "mcp-method": "tools/list" }, {
    jsonrpc: "2.0", id: 2, method: "tools/list", params: {},
  });

  await call("tools/call echo", { "mcp-method": "tools/call", "mcp-name": "echo" }, {
    jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: { text: "hello from Light" } },
  });

  console.log("\n✅ Demo complete. Stopping proxy.");
}

main()
  .catch((e) => {
    console.error("Demo failed:", e.message);
    process.exitCode = 1;
  })
  .finally(() => {
    proxy.kill();
  });
