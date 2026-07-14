import type { IncomingMessage, ServerResponse } from "node:http";
import type { Implementation, ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";
import type { LegacyClientManager } from "./legacy-client.js";
import { logger } from "./logger.js";

const PROTOCOL_VERSION = "2026-07-28";

/** Methods that REQUIRE the `Mcp-Name` header per SEP-2243. */
const NAME_REQUIRED_METHODS = new Set(["tools/call", "resources/read", "prompts/get"]);

const NOTIFICATION_METHODS = new Set([
  "notifications/initialized",
  "notifications/cancelled",
  "notifications/message",
]);

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

class RpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/** Decode the Base64 sentinel form `=?base64?...?=` used for non-ASCII header values. */
function decodeHeaderValue(value: string): string {
  const sentinel = /^[=?]base64[?](.*)[?]=$/.exec(value);
  if (sentinel) {
    try {
      return Buffer.from(sentinel[1], "base64").toString("utf8");
    } catch {
      return value;
    }
  }
  return value;
}

/** The 2026-07-28 wire format tags every result with a completion state. */
function withResultType<T extends object>(result: T): T & { resultType: "complete" } {
  return { ...result, resultType: "complete" };
}

function discoverResult(meta: { serverInfo?: Implementation; capabilities?: ServerCapabilities }) {
  return {
    resultType: "complete" as const,
    supportedVersions: [PROTOCOL_VERSION],
    capabilities: meta.capabilities ?? { tools: {} },
    serverInfo: meta.serverInfo ?? { name: "mcpsense-proxy-backend", version: "0.1.0" },
    instructions:
      "This server is bridged by MCPSense from a legacy, stateful MCP server. It speaks the 2026-07-28 stateless protocol on the front end.",
    ttlMs: 3_600_000,
    cacheScope: "public",
  };
}

/**
 * Forward a single decoded JSON-RPC request to the legacy backend client and
 * return the (2026-shaped) result. Throws `RpcError` on failure.
 */
async function dispatch(req: JsonRpcRequest, manager: LegacyClientManager): Promise<object> {
  const client = manager.getClient();
  const params = req.params ?? {};

  switch (req.method) {
    case "server/discover":
      return discoverResult(manager.getMeta());

    case "initialize":
      // A 2025-era client may still open with `initialize`; answer from cached caps.
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: manager.getMeta().capabilities ?? {},
        serverInfo: manager.getMeta().serverInfo ?? { name: "mcpsense-proxy-backend", version: "0.1.0" },
        instructions: "Bridged by MCPSense.",
      };

    case "tools/list":
      return withResultType(await client.listTools());

    case "tools/call": {
      const name = params.name;
      if (typeof name !== "string") throw new RpcError(-32602, "tools/call requires params.name");
      return withResultType(
        await client.callTool({ name, arguments: (params.arguments as Record<string, unknown>) ?? {} }),
      );
    }

    case "resources/list":
      return withResultType(await client.listResources());

    case "resources/read": {
      const uri = params.uri;
      if (typeof uri !== "string") throw new RpcError(-32602, "resources/read requires params.uri");
      return withResultType(await client.readResource({ uri }));
    }

    case "resources/templates/list":
      return withResultType(await client.listResourceTemplates());

    case "prompts/list":
      return withResultType(await client.listPrompts());

    case "prompts/get": {
      const name = params.name;
      if (typeof name !== "string") throw new RpcError(-32602, "prompts/get requires params.name");
      return withResultType(
        await client.getPrompt({ name, arguments: (params.arguments as Record<string, string>) ?? {} }),
      );
    }

    case "ping":
      return {};

    default:
      throw new RpcError(-32601, `Method not found: ${req.method}`);
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

/** SEP-2243 validation: required headers present and consistent with the body. */
function validateHeaders(req: IncomingMessage, body: JsonRpcRequest): void {
  const methodHeader = req.headers["mcp-method"];
  if (typeof methodHeader !== "string" || methodHeader.length === 0) {
    throw new RpcError(-32001, "Missing required Mcp-Method header");
  }
  // Method values are case-sensitive (SEP-2243 conformance tests reject TOOLS/CALL).
  if (methodHeader !== body.method) {
    throw new RpcError(-32001, "Mcp-Method header does not match request body method");
  }

  if (NAME_REQUIRED_METHODS.has(body.method)) {
    const nameHeaderRaw = req.headers["mcp-name"];
    if (typeof nameHeaderRaw !== "string" || nameHeaderRaw.length === 0) {
      throw new RpcError(-32001, "Missing required Mcp-Name header");
    }
    const nameHeader = decodeHeaderValue(nameHeaderRaw);
    const bodyName = (body.params?.name ?? body.params?.uri) as string | undefined;
    if (typeof bodyName === "string" && nameHeader !== bodyName) {
      throw new RpcError(-32001, "Mcp-Name header does not match request body name");
    }
  }

  // MCP-Protocol-Version header must match the _meta value when both are present.
  const pvHeader = req.headers["mcp-protocol-version"];
  const pvMeta = (body.params?._meta as Record<string, unknown> | undefined)?.[
    "io.modelcontextprotocol/protocolVersion"
  ];
  if (typeof pvHeader === "string" && typeof pvMeta === "string" && pvHeader !== pvMeta) {
    throw new RpcError(-32001, "MCP-Protocol-Version header does not match _meta protocolVersion");
  }
}

export interface ProxyOptions {
  onRequest?: (e: { method: string; status: number; latencyMs: number; name?: string }) => void;
}

export function createProxyHandler(manager: LegacyClientManager, options?: ProxyOptions) {
  const onRequest = options?.onRequest;
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const traceparent = req.headers["traceparent"];
    const traceHeaders: Record<string, string> = traceparent ? { traceparent: String(traceparent) } : {};
    const startTime = Date.now();

    if (req.method === "GET") {
      // Server→client notification stream. MVP keeps it open but pushes nothing.
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        ...traceHeaders,
      });
      req.on("close", () => res.end());
      return;
    }

    if (req.method === "DELETE") {
      res.writeHead(202, traceHeaders);
      res.end();
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST, GET, DELETE" });
      res.end();
      return;
    }

    let raw: Buffer;
    try {
      raw = await readBody(req);
    } catch {
      sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, traceHeaders);
      return;
    }

    let body: JsonRpcRequest;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, traceHeaders);
      return;
    }

    const isNotification = NOTIFICATION_METHODS.has(body.method) || body.id === undefined;

    try {
      validateHeaders(req, body);
      const name = (body.params?.name ?? body.params?.uri) as string | undefined;
      const result = await dispatch(body, manager);

      if (isNotification) {
        logger.info({ method: body.method, latencyMs: Date.now() - startTime }, "notification handled");
        onRequest?.({ method: body.method, status: 202, latencyMs: Date.now() - startTime, name });
        res.writeHead(202, traceHeaders);
        res.end();
        return;
      }

      logger.info(
        { method: body.method, name, latencyMs: Date.now() - startTime, status: "success" },
        "request bridged",
      );
      onRequest?.({ method: body.method, status: 200, latencyMs: Date.now() - startTime, name });
      sendJson(
        res,
        200,
        { jsonrpc: "2.0", id: body.id ?? null, result },
        { "Mcp-Method": body.method, ...traceHeaders },
      );
    } catch (err) {
      const rpcErr = err instanceof RpcError ? err : new RpcError(-32603, (err as Error).message ?? "Internal error");
      const status = rpcErr.code === -32601 ? 400 : rpcErr.code === -32001 ? 400 : 500;
      logger.error(
        { method: body.method, latencyMs: Date.now() - startTime, code: rpcErr.code, message: rpcErr.message },
        "request failed",
      );
      onRequest?.({
        method: body?.method ?? "unknown",
        status,
        latencyMs: Date.now() - startTime,
        name: (body?.params?.name ?? body?.params?.uri) as string | undefined,
      });
      if (isNotification) {
        res.writeHead(202, traceHeaders);
        res.end();
        return;
      }
      sendJson(
        res,
        status,
        { jsonrpc: "2.0", id: body.id ?? null, error: { code: rpcErr.code, message: rpcErr.message } },
        { "Mcp-Method": body.method, ...traceHeaders },
      );
    }
  };
}
