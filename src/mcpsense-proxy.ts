#!/usr/bin/env node
import { Command } from "commander";
import { createServer } from "node:http";
import { LegacyClientManager } from "./legacy-client.js";
import { createProxyHandler } from "./proxy-server.js";
import { logger } from "./logger.js";

const program = new Command();
program
  .name("mcpsense-proxy")
  .description("Zero-config bridge from legacy stateful MCP servers to July 28, 2026 stateless clients")
  .option("-p, --port <number>", "Port to run the HTTP proxy on", "8080")
  .option("--host <string>", "Host to bind the proxy to", "localhost")
  .option("-e, --endpoint <string>", "Endpoint path to serve", "/mcp");

// The legacy server command follows a `--` separator so its own flags are not
// swallowed by commander (e.g. `mcpsense-proxy -- node old-server.js --flag`).
const argv = process.argv;
const dashIndex = argv.indexOf("--");
const legacyCommand = dashIndex >= 0 ? argv.slice(dashIndex + 1) : [];
program.parse(argv.slice(0, dashIndex >= 0 ? dashIndex : argv.length));

const opts = program.opts<{ port: string; host: string; endpoint: string }>();
const port = Number.parseInt(opts.port, 10);
const host = opts.host;
const endpoint = opts.endpoint;

if (legacyCommand.length === 0) {
  logger.error("No legacy server command provided. Usage: mcpsense-proxy -- node old-server.js");
  process.exit(1);
}

const [command, ...args] = legacyCommand;

async function main(): Promise<void> {
  const manager = new LegacyClientManager(command, args);
  await manager.bootstrap();

  const handler = createProxyHandler(manager);
  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === endpoint || url.startsWith(`${endpoint}?`)) {
      handler(req, res).catch((e) => {
        logger.error({ err: (e as Error).message }, "unhandled handler error");
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end(`Not found. MCP endpoint is at ${endpoint}`);
    }
  });

  server.listen(port, host, () => {
    logger.info(`MCPSense proxy listening on http://${host}:${port}${endpoint}`);
    logger.info("Accepting stateless 2026-07-28 clients; forwarding to legacy backend.");
  });
}

main().catch((e) => {
  logger.error({ err: (e as Error).message }, "failed to start proxy");
  process.exit(1);
});
