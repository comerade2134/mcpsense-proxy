import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// A deliberately "legacy" server: it speaks the stateful 2024/2025 protocol and
// REQUIRES the `initialize` handshake (the SDK client performs it automatically).
const server = new Server(
  { name: "fixture-legacy", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "greet",
      description: "Greet someone by name",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = (request.params.arguments as { name?: string } | undefined)?.name ?? "stranger";
  return {
    content: [{ type: "text", text: `Hello, ${name}!` }],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
