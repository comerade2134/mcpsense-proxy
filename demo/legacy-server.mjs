// A tiny but REAL legacy (stateful) MCP server over stdio, built with the
// official SDK. It requires the old `initialize` handshake — exactly the kind
// of server mcpsense-proxy is meant to bridge to 2026-07-28 clients.
//
// Run it directly (no build step needed):
//   node demo/legacy-server.mjs
// or behind the proxy:
//   node bin/mcpsense-proxy.js --port 8080 -- node demo/legacy-server.mjs
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "demo-legacy", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "Echo back whatever text you send",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const text = (request.params.arguments ?? {}).text ?? "";
  return { content: [{ type: "text", text: `legacy echoed: ${text}` }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
