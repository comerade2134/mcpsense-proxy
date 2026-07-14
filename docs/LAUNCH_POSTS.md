# Launch posts — MCPSense Cloud

Paste-ready copy for the launch. **You must post these from your own HN /
Reddit accounts** — the assistant cannot authenticate to those platforms.

Repo: https://github.com/comerade2134/mcpsense-proxy
Landing: https://comerade2134.github.io/mcpsense-proxy/

---

## 1) Hacker News — Show HN

**Title:**
Show HN: mcpsense-proxy – bridge legacy stateful MCP servers to the July 28, 2026 stateless spec

**Body:**
On July 28, 2026 the MCP spec goes stateless: SEP-2243 requires Mcp-Method/Mcp-Name
headers (mismatch → 400 / -32001), SEP-2567 removes Mcp-Session-Id, and SEP-2575
removes the initialize handshake. If you run a "legacy" stateful MCP server, clients
built for the new spec can silently break against it.

mcpsense-proxy is a zero-config compatibility shim. Point it at your existing server
(stdio or remote HTTP) and it speaks the new stateless protocol on the front end
while leaving your backend untouched:

    npx -y mcpsense-proxy --stdio "your-server --flags"
    # or for a remote legacy HTTP server:
    npx -y mcpsense-proxy --remote https://your-host/mcp

New in this release — MCPSense Cloud, a multi-tenant mode. One process bridges many
backends:

- Remote registration is public and safe (outbound HTTP only).
- Stdio registration is gated by a REGISTER_KEY to prevent RCE.
- Each tenant gets a Bearer token; /t/<id>/mcp (bridge) and /t/<id>/logs are
  token-checked, so tenants can't read each other.
- Tokens are stored hashed (sha256) and verified constant-time.
- Per-tenant request logs (capped JSONL). Stripe test-mode checkout + webhook wired
  via client_reference_id.

Open source, Node + TypeScript. Demo + landing linked above. Feedback welcome.

---

## 2) Reddit — r/ClaudeMCP

**Title:**
mcpsense-proxy: keep your stateful MCP server working after the July 28 stateless spec

**Body:**
If you run an MCP server for Claude (or any client) and you're worried about the
July 28, 2026 stateless spec breaking things, mcpsense-proxy is a drop-in shim.

- Front end is fully 2026-07-28 compliant (Mcp-Method / Mcp-Name, server/discover,
  validation, traceparent).
- Back end stays exactly as your server is today — stdio or a remote legacy HTTP
  endpoint.
- Zero config: `npx -y mcpsense-proxy --stdio "your-server"`.

It also now has a multi-tenant Cloud mode (mcpsense-cloud) for hosting several
backends behind one endpoint, with per-tenant Bearer tokens, an RCE-guarded stdio
register path, and request logging.

GitHub + demo in the comments.

---

## 3) Reddit — r/MCP

**Title:**
mcpsense-proxy v0.1 — bridge stateful MCP servers to the 2026-07-28 stateless spec (+ multi-tenant Cloud)

**Body:**
Technical summary of what mcpsense-proxy does and the new Cloud slice:

- Transparent forwarding — real tool/resource/prompt names, no synthetic bridge tool.
- The hand-rolled stateless front end (the official SDK predates the July 28
  features) handles Mcp-Method/Mcp-Name, header/body consistency validation, and
  server/discover.
- LegacyClientManager reuses the SDK client for the initialize handshake against the
  backend.

Cloud slice (src/cloud):
- TenantRegistry: sha256 token hashing + constant-time verify (length-guarded),
  stdio registration gated by REGISTER_KEY (RCE guard), remote registration public,
  lazy per-tenant manager bootstrap with in-flight dedupe, JSON persistence.
- cloud-server: /register (remote public / stdio gated), Bearer-gated /t/<id>/mcp
  bridging + /t/<id>/logs, /health, Stripe /billing/checkout + /stripe/webhook
  (client_reference_id mapping).
- 25 tests green, build clean.

Repo: https://github.com/comerade2134/mcpsense-proxy
