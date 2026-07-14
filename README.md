# mcpsense-proxy

Zero-config compatibility proxy that bridges **legacy, stateful MCP servers** to the
**July 28, 2026 stateless MCP clients** — without touching the legacy server's code.

On July 28, 2026, MCP removes the `initialize` handshake and the `Mcp-Session-Id`
header (SEP-2575 / SEP-2567) and requires `Mcp-Method` / `Mcp-Name` routing headers
(SEP-2243). Remote legacy servers that rely on sessions silently break. MCPSense sits
in front of them and speaks the new stateless protocol on the front end while keeping a
single warm, stateful session with the legacy server on the back end.

## Install & run

```bash
npx mcpsense-proxy --port 8080 -- node old-server.js
```

Then point any 2026-07-28 client at `http://localhost:8080/mcp`.

- Everything after `--` is the legacy server's start command and its arguments.
- One legacy server process is spawned and warmed up (the `initialize` handshake runs
  at startup, so the first request has no handshake latency).

## How it works

```
2026 client ──HTTP/Streamable (stateless, Mcp-Method/Mcp-Name)──▶ mcpsense-proxy
                                                                        │
                                              forwards by real tool/resource/prompt name
                                                                        ▼
                                              legacy MCP server (stdio, stateful session)
```

- **Front end**: a hand-rolled stateless Streamable HTTP server implementing the
  2026-07-28 wire format — required `Mcp-Method` / `Mcp-Name` headers, `server/discover`,
  `_meta` protocol-version matching, and `400 / -32001` header/body validation.
- **Back end**: the official `@modelcontextprotocol/sdk` `Client` + `StdioClientTransport`,
  which performs the legacy `initialize` handshake automatically and keeps the session warm.
- **Model**: one upstream session per proxy instance (single-user local use). Multi-tenant
  session isolation is intentionally deferred to the managed cloud tier.

## Develop

```bash
npm install
npm run dev -- -- node old-server.js      # tsx, no build step
npm test                                   # vitest integration suite
npm run build && npm start -- -- node old-server.js
```

## License

MIT
