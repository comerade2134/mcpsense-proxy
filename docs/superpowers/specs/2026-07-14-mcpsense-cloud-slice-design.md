# MCPSense Cloud — Thin Vertical Slice Design

**Date:** 2026-07-14
**Status:** Approved (design) — pending spec review
**Goal:** Prove the full cloud loop small: register a backend → isolated session → basic logs → Stripe test mode. This is the first sub-project of the larger "MCPSense Cloud" tier; later sub-projects (real auth, dashboard UI, billing hardening, horizontal scaling) build on this foundation.

## Constraints & decisions (from brainstorming)

- **Tenancy:** Single long-running Node process holds N `LegacyClientManager` instances keyed by tenant, each served at `/t/<tenantId>/mcp`.
- **Identity:** `POST /register` returns a `tenantId`, an endpoint, and a bearer `token`. No login UI in this slice.
- **Persistence:** JSON file (`data/tenants.json` + `data/logs/<tenantId>.jsonl`). No external DB.
- **Structure:** Extend in-place under `src/cloud/`, reusing `LegacyClientManager`, `RemoteHttpClientTransport`, and `createProxyHandler` unchanged except one optional hook.

## Architecture

```
2026 client ──▶ /t/<tenantId>/mcp (+Bearer token) ──▶ cloud-server
                                                      │ verifies token
                                                      ▼ tenant's LegacyClientManager
                                       legacy backend (stdio child OR remote HTTP session)
```

One process, many tenants. Each tenant owns an independent `LegacyClientManager` (independent SDK `Client`, transport, and warm session). The 2026-07-28 front-end logic is the existing `createProxyHandler`, shared across all tenants.

## Components (`src/cloud/`)

- **`tenant-registry.ts`** — loads/saves `data/tenants.json`. Holds `Map<tenantId, { manager: LegacyClientManager, meta }>`. On register, builds the correct transport (`StdioClientTransport` or `RemoteHttpClientTransport`) and bootstraps the manager (performs the legacy `initialize` handshake, prefetches lists).
- **`cloud-server.ts`** — one `http` server with the routes below.
- **`request-log.ts`** — appends `{ts, method, status, latencyMs, name?}` to `data/logs/<tenantId>.jsonl` (capped ring, e.g. last 1000 lines).
- **`mcpsense-cloud.ts`** — CLI entry; new `bin/mcpsense-cloud`.

## API surface

- `POST /register`
  - Body `{type:"remote", url}` → **public**, always allowed. Safe: the cloud only sends outbound HTTP to the legacy server; it executes no code.
  - Body `{type:"stdio", command, args}` → **restricted**. Allowed only if the server was started with a `REGISTER_KEY` env var; the request must include it (header `x-register-key` or matching body field). Without it, returns `403 Forbidden`. This is the RCE guard (see Security).
  - Success returns `{tenantId, endpoint:"/t/<tenantId>/mcp", token}`.
- `POST /t/<tenantId>/mcp` — **requires `Authorization: Bearer <token>`**. On match, delegates to that tenant's `createProxyHandler(manager)`. This IS the isolation boundary.
- `GET /t/<tenantId>/logs` — recent request log for that tenant (token required).
- `POST /billing/checkout` — creates a Stripe Checkout Session (test mode) with `client_reference_id = tenantId` and a `success_url`.
- `POST /stripe/webhook` — on `checkout.session.completed`, flips `tenant.paid = true`. Verifies the Stripe webhook signature with `STRIPE_WEBHOOK_SECRET`.
- `GET /health`.

## Security model (critical)

**The RCE gotcha.** A public `POST /register` that accepts an arbitrary `command`/`args` and spawns it via `child_process.spawn` is remote code execution. An attacker would send `{type:"stdio", command:"rm", args:["-rf","/"]}` or spin up a crypto miner on our CPU. This is unacceptable for any internet-facing beta.

**The rule (cheap, no sandbox needed):**
- **`remote` registration is public.** Our cloud proxy only makes outbound HTTP requests to the legacy server; it never executes code. Safe by construction.
- **`stdio` registration is gated.** Disabled on the public API by default. To allow it (local dev, private beta), the server must be started with `REGISTER_KEY`, and the registration request must present it. Without the key, `type:"stdio"` → `403`.

This keeps the server safe while still letting us test stdio locally or in a trusted private beta.

**Known residual risk (not fixed in this slice, noted for later):** `remote` registration enables SSRF — a tenant could point the proxy at an internal endpoint (e.g. `http://169.254.169.254/…`). Acceptable for a trusted/private beta; a later sub-project adds an allow-list / egress filter. The `token` check on `/t/<id>/mcp` already prevents cross-tenant access.

**Token handling:** tokens are stored hashed (`sha256`) in `data/tenants.json`; only the plaintext token is returned once at registration. `Bearer` auth is required on all tenant-scoped routes.

## Request flow

1. Client → `POST /t/<tenantId>/mcp` with `Bearer <token>`.
2. cloud-server verifies the token against `tenant-registry` (constant-time compare of hashes).
3. On match, calls the tenant's existing `createProxyHandler(manager)` (unchanged 2026-07-28 logic).
4. `LegacyClientManager` forwards to that tenant's legacy backend over its own warm session.
5. Per-request result is written to that tenant's `data/logs/<tenantId>.jsonl` via the `onRequest` hook.

## Small extension to existing code

`createProxyHandler` gains an optional `onRequest({method, status, latencyMs, name})` callback, invoked on every completed request (success or failure). This lets the cloud capture logs without the proxy knowing anything about "cloud". All other proxy modules are reused as-is.

## Data model (JSON)

`data/tenants.json`:
```json
{
  "tenants": [
    {
      "id": "t_abc123",
      "tokenHash": "<sha256>",
      "kind": "remote",
      "remoteUrl": "https://legacy.example.com/mcp",
      "endpoint": "/t/t_abc123/mcp",
      "paid": false,
      "createdAt": 1784045880
    }
  ]
}
```

`data/logs/<tenantId>.jsonl` (one JSON object per line, capped):
```json
{"ts":1784045881,"method":"tools/call","status":200,"latencyMs":3,"name":"echo"}
```

## Error handling & isolation

- Missing/invalid token → `401`. Unknown tenant → `404`. `type:"stdio"` without `REGISTER_KEY` → `403`.
- Per-tenant failures are isolated: each tenant has its own manager; an exception in one request is caught and does not affect other tenants.
- Missing `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` → billing endpoints return `503` with a clear message; the rest of the slice works without Stripe.

## Testing (vitest)

- Register a `remote` tenant pointing at the in-repo fixture remote legacy server → call `/t/<id>/mcp` with token → assert `server/discover` + `tools/call` bridge correctly.
- Attempt `type:"stdio"` registration without `REGISTER_KEY` → assert `403`; with the key → assert success.
- Hit `/t/<id>/logs` → assert entries recorded.
- Simulate the Stripe webhook (signed, test key) → assert `paid=true`.
- Negative: wrong token → `401`; unknown tenant → `404`.

## Explicitly OUT of scope (YAGNI for this slice)

Real user accounts / passwords, OAuth, dashboard UI, horizontal scaling, per-tenant containers, a real RDBMS, alerting, SSO, enterprise SLA, SSRF egress filtering. These are later sub-projects once this loop is proven.

## Success criteria

- A user can register a `remote` backend via the public API and immediately bridge it with a 2026-07-28 client.
- Tenants are isolated (token-checked); no cross-tenant access; no RCE via stdio.
- Request logs are persisted per tenant and retrievable.
- A Stripe test-mode checkout flips a tenant to `paid` via webhook.
- All of the above covered by automated tests.
