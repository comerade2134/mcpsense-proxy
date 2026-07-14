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

### Remote backend (Phase 4)

Instead of spawning a local command, you can bridge a **remote, stateful legacy server**
that already speaks Streamable HTTP and expects the `Mcp-Session-Id` header:

```bash
npx mcpsense-proxy --port 8080 --remote https://legacy.example.com/mcp
```

MCPSense owns the remote session — it performs `initialize` against the remote server,
captures the returned `Mcp-Session-Id`, and injects it on every forwarded request. The
2026-07-28 stateless front end is identical; only the back end differs.

## How it works

```
2026 client ──HTTP/Streamable (stateless, Mcp-Method/Mcp-Name)──▶ mcpsense-proxy
                                                                         │
                                               forwards by real tool/resource/prompt name
                                                                         ▼
                        legacy MCP server ── stdio ── OR ── remote Streamable HTTP (session)
```

- **Front end**: a hand-rolled stateless Streamable HTTP server implementing the
  2026-07-28 wire format — required `Mcp-Method` / `Mcp-Name` headers, `server/discover`,
  `_meta` protocol-version matching, and `400 / -32001` header/body validation.
- **Back end**: the official `@modelcontextprotocol/sdk` `Client` driving either a
  `StdioClientTransport` (local child process) or a `RemoteHttpClientTransport`
  (remote Streamable HTTP server expecting `Mcp-Session-Id`). Both perform the legacy
  `initialize` handshake automatically and keep the session warm.
- **Model**: one upstream session per proxy instance (single-user local use). Multi-tenant
  session isolation is intentionally deferred to the managed cloud tier.

## Develop

```bash
npm install
npm run dev -- -- node old-server.js      # tsx, no build step
npm test                                   # vitest integration suite
npm run build && npm start -- -- node old-server.js
```

## See it work

`npm run demo` starts the proxy with the bundled demo legacy server and runs three
example 2026-07-28 requests end-to-end:

```text
$ npm run demo

Starting mcpsense-proxy on http://127.0.0.1:8080/mcp (bridging demo/legacy-server.mjs)...
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
    "instructions": "This server is bridged by MCPSense from a legacy, stateful MCP server...",
    "ttlMs": 3600000,
    "cacheScope": "public"
  }
}

$ tools/list
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": { "tools": [{ "name": "echo", "description": "Echo back whatever text you send", ... }], "resultType": "complete" }
}

$ tools/call echo
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": { "content": [{ "type": "text", "text": "legacy echoed: hello from Light" }], "resultType": "complete" }
}

✅ Demo complete. Stopping proxy.
```

### Animated demo

A replayable terminal cast lives at [`demo/terminal-demo.cast`](demo/terminal-demo.cast)
(view it on [asciinema.org](https://asciinema.org) or paste it there). To render a shareable
GIF for posts/README:

```bash
npm i -g asciinema agg
agg demo/terminal-demo.cast demo.gif
# then embed in README/markdown with: ![demo](demo.gif)
```

## Managed Cloud (waitlist)

If you need your legacy servers hosted securely in a managed, auto-scaling environment
with centralized request logs and real-time spec-compliance alerts, join the waitlist.

👉 **[Join the MCPSense Cloud Beta waitlist](https://comerade2134.github.io/mcpsense-proxy/)** — or open an issue
titled **"Cloud waitlist"** at `https://github.com/comerade2134/mcpsense-proxy/issues`.

## ☁️ Going to Production? Meet MCPSense Cloud ($19/seat)

While the local CLI is great for testing and local development, running mission-critical
enterprise AI pipelines on a developer's laptop is a recipe for downtime.

**MCPSense Cloud** is our upcoming managed hosting platform built for high-velocity teams:

- **Zero-Downtime Hosting:** Deploy your legacy MCP servers on serverless, auto-scaling infrastructure.
- **Multi-Tenant Session Isolation:** Safely multiplex developer requests with enterprise-grade session routing.
- **Compliance & Audit Logs:** Real-time logging of tool latency, status, and payload signatures (essential for security audits).
- **Alerting:** Get notified before things break when clients roll out runtime updates.

👉 **[Join the MCPSense Cloud Beta Waitlist](https://comerade2134.github.io/mcpsense-proxy/)** to secure early access and lock in beta pricing.

## MCPSense Cloud (local dev)

The same proxy, multi-tenant. Run the cloud server:

```bash
npm run build
REGISTER_KEY=your-dev-key PORT=8080 node bin/cloud/mcpsense-cloud.js
```

- `POST /register` with `{ "type": "remote", "url": "..." }` is **public** and safe (only outbound HTTP).
- `POST /register` with `{ "type": "stdio", "command": "...", "args": [...] }` requires the `REGISTER_KEY` header/field (prevents RCE).
- Bridge a tenant: `POST /t/<tenantId>/mcp` with `Authorization: Bearer <token>`.
- View logs: `GET /t/<tenantId>/logs` (token required).
- Billing (test mode): `POST /billing/checkout`, `POST /stripe/webhook` (needs `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`).

State lives in `data/tenants.json` + `data/logs/<tenantId>.jsonl`.

### Production deployment

The cloud server is a single Node process behind any reverse proxy (nginx, Caddy, a
container platform). Build the image once and run it with a persisted `/app/data` volume.

#### Docker

```bash
docker build -t mcpsense-proxy .
```

```bash
docker run -d --name mcpsense-cloud \
  -p 8080:8080 \
  -v $(pwd)/data:/app/data \
  -e PORT=8080 \
  -e REGISTER_KEY=<strong-random> \
  -e REMOTE_EGRESS_ALLOWLIST=api.openai.com,api.anthropic.com \
  mcpsense-proxy:latest
```

The container runs as the non-root `node` user, so the mounted volume must be writable
by that UID (e.g. `chown -R 1000:1000 ./data` before first run).

#### Environment variables

| Var | Required | Default | Purpose |
| `PORT` | no | `8080` | Listen port |
| `REGISTER_KEY` | for stdio backends | — | Gate `stdio` registration (RCE guard) |
| `REMOTE_EGRESS_ALLOWLIST` | recommended | (empty = block all literal private/loopback IPs, allow hostnames) | Comma-separated hosts/IPs allowed as `remote` backend targets |
| `STRIPE_SECRET_KEY` | for paid mode | — | Enables paid gating; unset = free mode |
| `STRIPE_WEBHOOK_SECRET` | with Stripe | — | Verifies webhooks |
| `STRIPE_PRICE_ID` | with Stripe | — | Default price for checkout |
| `PUBLIC_BASE_URL` | with Stripe | `https://comerade2134.github.io/mcpsense-proxy` | Base for the `checkout` link + same-origin `success_url` restriction |
| `DATA_DIR` | no | `./data` | Tenant DB + logs (mount a volume) |

#### Security notes

- `stdio` registration requires `REGISTER_KEY`; without it, `POST /register` with a
  `stdio` type is rejected (prevents RCE via command injection).
- The container runs as the non-root `node` user.
- `REMOTE_EGRESS_ALLOWLIST` **MUST** be set before exposing `/register` publicly.
  Without it the egress filter allows hostnames but blocks literal private/loopback IPs
  by design — set the allowlist to pin exactly the hosts your tenants may reach.
- The `checkout` `success_url` is restricted to the origin of `PUBLIC_BASE_URL`, so a
  caller cannot redirect a post-payment browser to an arbitrary external origin.

#### Known limitations (be explicit)

- **Single-instance only.** The store is a JSON file (`data/tenants.json`); there is no
  multi-replica support. Run one container per deployment and keep its volume exclusive.
- **DNS-rebinding on `remote` hostnames is NOT mitigated.** The allowlist matches the
  registered hostname, not the IP it later resolves to. Register only hostnames you
  trust, or pin them via `REMOTE_EGRESS_ALLOWLIST`.
- **`checkout` has no auth.** Anyone who can reach `/billing/checkout` can start a Stripe
  session. Acceptable for the thin slice; note it before public exposure.
- **Tenants are not isolated accounts.** There is no multi-user dashboard or per-tenant
  login — each tenant is just an internal record. True account isolation is v2.

## License

MIT
