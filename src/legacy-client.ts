import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Implementation, ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { logger } from "./logger.js";

export interface LegacyMeta {
  serverInfo: Implementation | undefined;
  capabilities: ServerCapabilities | undefined;
}

/**
 * Owns the single, warm, stateful session with the legacy MCP server.
 *
 * The legacy child is spawned over stdio and the SDK `Client` performs the
 * `initialize` handshake automatically on `connect()`. We then prefetch the
 * list endpoints so that `tools/list` and `server/discover` are instant and
 * accurate. Every 2026-style request the proxy receives is forwarded through
 * this one shared client — that is the entire "secret sauce".
 */
export class LegacyClientManager {
  private client: Client | null = null;
  private serverInfo: Implementation | undefined;
  private capabilities: ServerCapabilities | undefined;
  private tools: unknown[] = [];
  private resources: unknown[] = [];
  private resourceTemplates: unknown[] = [];
  private prompts: unknown[] = [];

  /**
   * @param transport A connected-or-connectable transport to the legacy backend.
   *                  Use `StdioClientTransport` for a local child process or
   *                  `RemoteHttpClientTransport` for a remote stateful HTTP server.
   */
  constructor(private readonly transport: Transport) {}

  async bootstrap(): Promise<void> {
    logger.info("warming up legacy MCP backend session");

    this.client = new Client(
      { name: "mcpsense-bridge", version: "0.1.0" },
      { capabilities: {} },
    );

    // SDK 1.29.0 performs the legacy `initialize` handshake here automatically.
    await this.client.connect(this.transport);

    this.serverInfo = this.client.getServerVersion();
    this.capabilities = this.client.getServerCapabilities();
    logger.info({ serverInfo: this.serverInfo }, "legacy backend initialized (warm-up handshake complete)");

    await this.prefetch();
  }

  private async prefetch(): Promise<void> {
    const client = this.client!;
    try {
      this.tools = (await client.listTools()).tools;
    } catch (e) {
      logger.warn({ err: (e as Error).message }, "legacy server has no tools/list");
    }
    try {
      this.resources = (await client.listResources()).resources;
    } catch {
      /* no resources */
    }
    try {
      this.resourceTemplates = (await client.listResourceTemplates()).resourceTemplates;
    } catch {
      /* no resource templates */
    }
    try {
      this.prompts = (await client.listPrompts()).prompts;
    } catch {
      /* no prompts */
    }
  }

  getMeta(): LegacyMeta {
    return { serverInfo: this.serverInfo, capabilities: this.capabilities };
  }

  getCachedLists() {
    return {
      tools: this.tools,
      resources: this.resources,
      resourceTemplates: this.resourceTemplates,
      prompts: this.prompts,
    };
  }

  getClient(): Client {
    if (!this.client) {
      throw new Error("LegacyClientManager not bootstrapped; call bootstrap() first");
    }
    return this.client;
  }
}
