// Generates demo/terminal-demo.cast — an asciinema v2 replay of `npm run demo`.
// Pure Node, no deps. Upload to asciinema.org, or convert to GIF locally with:
//   npm i -g asciinema agg   (then: agg terminal-demo.cast demo.gif)
import { writeFileSync } from "node:fs";

const text = `Starting mcpsense-proxy on http://127.0.0.1:8080/mcp (bridging demo/legacy-server.mjs)...
Proxy is up. Running example 2026-07-28 requests:

$ server/discover
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "resultType": "complete",
    "supportedVersions": ["2026-07-28"],
    "capabilities": { "tools": {} },
    "serverInfo": { "name": "demo-legacy", "version": "1.0.0" },
    "instructions": "This server is bridged by MCPSense from a legacy, stateful MCP server. It speaks the 2026-07-28 stateless protocol on the front end.",
    "ttlMs": 3600000,
    "cacheScope": "public"
  }
}

$ tools/list
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": { "tools": [{ "name": "echo", "description": "Echo back whatever text you send", "inputSchema": { "type": "object", "properties": { "text": { "type": "string" } }, "required": ["text"] } }], "resultType": "complete" }
}

$ tools/call echo
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": { "content": [{ "type": "text", "text": "legacy echoed: hello from Light" }], "resultType": "complete" }
}

✅ Demo complete. Stopping proxy.
`;

const header = { version: 2, width: 100, height: 34, title: "npm run demo — mcpsense-proxy", timestamp: Math.floor(Date.now() / 1000) };
const lines = text.split("\n");
const events = [];
let t = 0;
for (const line of lines) {
  events.push([Number(t.toFixed(2)), "o", line + "\n"]);
  t += 0.08;
}
const cast = [JSON.stringify(header), ...events.map((e) => JSON.stringify(e))].join("\n") + "\n";
writeFileSync(new URL("../demo/terminal-demo.cast", import.meta.url), cast);
writeFileSync(new URL("../public/terminal-demo.cast", import.meta.url), cast);
console.log(`wrote demo/terminal-demo.cast + public/terminal-demo.cast (${events.length} frames)`);
