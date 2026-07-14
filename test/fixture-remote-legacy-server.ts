import { createServer, type Server } from "node:http";

/**
 * A *remote, stateful* legacy MCP server over Streamable HTTP — used by the
 * Phase 4 integration test. It mimics the pre-2026-07-28 behaviour the proxy
 * must bridge:
 *
 *   - POST a JSON-RPC message (optionally batched).
 *   - `initialize` generates a session id, returned in the `Mcp-Session-Id`
 *     response header, and echoed back by the client on every later request.
 *   - Any non-initialize request without a valid `Mcp-Session-Id` is rejected
 *     with 400 (this is exactly the header the SDK-on-stdio never needed).
 *   - Server→client messages (notifications) are pushed over the long-lived
 *     GET SSE stream.
 */
export function startRemoteLegacyFixture(): Promise<{ server: Server; url: string; port: number }> {
  const sessions = new Map<string, { initialized: boolean }>();
  const getStreams = new Map<string, (msg: unknown) => void>();
  let counter = 0;
  const newId = () => `sess-${(counter++).toString(36)}-${Date.now().toString(36)}`;

  const server = createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0];
    if (url !== "/mcp") {
      res.writeHead(404).end();
      return;
    }

    if (req.method === "GET") {
      const sid = req.headers["mcp-session-id"];
      if (typeof sid !== "string" || !sessions.has(sid)) {
        res.writeHead(400).end();
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const send = (msg: unknown) => {
        res.write(`event: message\ndata: ${JSON.stringify(msg)}\n\n`);
      };
      getStreams.set(sid, send);
      req.on("close", () => getStreams.delete(sid));
      return;
    }

    if (req.method === "DELETE") {
      const sid = req.headers["mcp-session-id"];
      if (typeof sid === "string") {
        sessions.delete(sid);
        getStreams.delete(sid);
      }
      res.writeHead(202).end();
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST, GET, DELETE" }).end();
      return;
    }

    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        res.writeHead(400).end();
        return;
      }
      const messages = Array.isArray(body) ? body : [body];
      const sidHeader = req.headers["mcp-session-id"];

      const respond = (result: unknown, status = 200, extraHeaders: Record<string, string> = {}) => {
        res.writeHead(status, { "Content-Type": "application/json", ...extraHeaders });
        res.end(JSON.stringify(result));
      };

      let activeSid: string | undefined;

      const handle = (msg: { id?: unknown; method?: string; params?: Record<string, unknown> }): unknown => {
        if (msg.method === "initialize") {
          const sid = newId();
          sessions.set(sid, { initialized: true });
          activeSid = sid;
          return {
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "fixture-remote-legacy", version: "1.0.0" },
            },
          };
        }

        // Every other method requires a valid session id.
        if (typeof sidHeader !== "string" || !sessions.has(sidHeader)) {
          return { jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "Missing Mcp-Session-Id" } };
        }
        activeSid = sidHeader;

        switch (msg.method) {
          case "tools/list":
            return {
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                tools: [
                  {
                    name: "greet",
                    description: "Greet someone by name",
                    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
                  },
                ],
              },
            };
          case "tools/call": {
            const name = (msg.params?.name as string) ?? "";
            const pname = ((msg.params?.arguments as { name?: string }) ?? {}).name ?? "stranger";
            if (name === "greet") {
              return {
                jsonrpc: "2.0",
                id: msg.id,
                result: { content: [{ type: "text", text: `Hello, ${pname}!` }] },
              };
            }
            return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unknown tool ${name}` } };
          }
          case "ping":
            return { jsonrpc: "2.0", id: msg.id, result: {} };
          default:
            return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `method ${msg.method} not found` } };
        }
      };

      const results = messages.map(handle);
      const responseBody = Array.isArray(body) ? results : results[0];
      const headers: Record<string, string> = {};
      if (activeSid) headers["Mcp-Session-Id"] = activeSid;
      respond(responseBody, 200, headers);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}/mcp`, port });
    });
  });
}
