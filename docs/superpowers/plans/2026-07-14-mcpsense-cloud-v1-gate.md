# MCPSense Cloud — v1 Hardening Gate

**Goal:** Close the security/prod gaps identified in the cloud-slice final review
before any public `npm publish` of `mcpsense-cloud`. The slice already works
(25 tests green, build clean). This gate makes it safe to put in front of
strangers.

**Ordering rule (from LO):** do ALL of this first; publish + announce is the
very last step, handled by LO. Do not publish, do not post.

**Scope decisions (assumptions — adjust later if wrong):**
- `paid` enforcement is ON only when `STRIPE_SECRET_KEY` is configured (free mode
  when billing is not set up). Enforced on `/t/<id>/mcp` with HTTP 402.
- "Basic auth" = token rotation + tenant disable (revocation). Full user-account
  dashboard is explicitly v2, NOT in this gate.
- Persistence stays JSON-file (single instance). Redis/multi-instance is v2.
- Real persistence / horizontal scaling / enterprise SLA = v2+.

---

### Task 1 — SSRF egress allowlist for `remote` registration

**Files:** `src/cloud/egress.ts` (new), `src/cloud/cloud-server.ts`, `src/cloud/tenant-registry.ts` (maybe), `test/cloud/egress.test.ts` (new).

**Why:** `remote` registration is PUBLIC and the server will `fetch`/connect to
whatever URL is given. Without a guard, anyone can point it at cloud metadata
(`169.254.169.254`), private IPs, or internal services.

- [ ] Step 1: write `test/cloud/egress.test.ts` asserting:
  - `isEgressAllowed("http://169.254.169.254/latest/meta-data")` → false
  - `isEgressAllowed("http://127.0.0.1:9/mcp")` → false (loopback blocked by default)
  - `isEgressAllowed("http://10.0.0.5/mcp")` → false (private RFC1918)
  - `isEgressAllowed("https://api.example.com/mcp")` → true
  - `isEgressAllowed("http://127.0.0.1:9/mcp", ["127.0.0.1"])` → true (explicit allow)
  - `isEgressAllowed("http://[::1]/mcp")` → false (IPv6 loopback)
- [ ] Step 2: run test, expect FAIL (module not found).
- [ ] Step 3: implement `src/cloud/egress.ts` exporting
  `isEgressAllowed(url: string, allowlist: string[] = []): boolean`:
  - Parse with `new URL(url)`. Only `http:`/`https:` schemes.
  - Resolve host: if `net.isIP(host)` is truthy, block if it is loopback,
    link-local (`169.254.0.0/16`), or private (RFC1918 `10/8`, `172.16/12`,
    `192.168/16`), or `::1`/ULA/`fc00::/7`. Use `node:net` `isIP` + simple range
    checks (no DNS resolution — host is used as given; if it's a hostname, allow
    it ONLY if it's in the `allowlist`; otherwise allow by default BUT note this
    is hostname-based and DNS-rebinding is out of scope for the slice — document
    it).
  - If `allowlist` contains the host (exact match or suffix match like
    `.example.com`), allow regardless.
  - Blocked IP ranges → return false.
- [ ] Step 4: wire into `cloud-server.ts`: on `handleRegister` for `remote`,
  compute `allowlist` from `opts.egressAllowlist` (seeded by env
  `REMOTE_EGRESS_ALLOWLIST`, comma-separated). If `!isEgressAllowed(url, allowlist)`
  → throw `"EGRESS_BLOCKED"`. Add mapping in the catch: `EGRESS_BLOCKED` → 400
  `{ error: "egress target not allowed" }`.
- [ ] Step 5: add a cloud-server integration test: register remote with
  `url:"http://169.254.169.254/mcp"` → 400; with a normal host → 200.
- [ ] Step 6: `npm test` green; `npm run build` clean.
- [ ] Step 7: commit `feat(cloud): add SSRF egress allowlist for remote register`

---

### Task 2 — `paid` enforcement on the bridge

**Files:** `src/cloud/cloud-server.ts`, `test/cloud/cloud-server.test.ts` (extend).

- [ ] Step 1: in `handleTenantMcp`, after token check, add:
  `if (opts.stripeSecretKey && !rec.paid) throw new Error("PAYMENT_REQUIRED");`
  Map `PAYMENT_REQUIRED` → 402 `{ error: "payment required" }`.
- [ ] Step 2: extend the cloud-server test `describe` with:
  - start server WITH `stripeSecretKey` set.
  - register remote (unpaid) → `POST /t/<id>/mcp` → 402.
  - flip paid via the existing webhook path (signed payload, `client_reference_id`
    = tenantId) → then `POST /t/<id>/mcp` → 200.
  - separate: start server WITHOUT `stripeSecretKey` → unpaid tenant's
    `POST /t/<id>/mcp` → 200 (free mode, no enforcement).
- [ ] Step 3: `npm test` green; build clean.
- [ ] Step 4: commit `feat(cloud): enforce paid state on bridge when billing enabled`

---

### Task 3 — token rotation + tenant disable (basic auth)

**Files:** `src/cloud/tenant-registry.ts`, `test/cloud/registry.test.ts` (extend),
`src/cloud/cloud-server.ts`, `test/cloud/cloud-server.test.ts` (extend).

- [ ] Step 1: in `TenantRegistry`, add:
  - `rotateToken(id: string): string | undefined` — finds record, generates a new
    `randomToken()`, updates `tokenHash`, `save()`, returns the plaintext (or
    `undefined` if id unknown).
  - `setDisabled(id: string, disabled: boolean): void` — sets `rec.disabled`
    (add optional `disabled?: boolean` to `TenantRecord`, default false), `save()`.
  - Unit tests: rotateToken returns a new token that verifies; old token no longer
    verifies; unknown id → undefined. setDisabled toggles; disabled record still
    loads from disk.
- [ ] Step 2: `handleTenantMcp` + `handleTenantLogs`: after token check, if
  `rec.disabled` → throw `"TENANT_DISABLED"` → 403.
- [ ] Step 3: add cloud endpoint `POST /t/<id>/rotate` (Bearer current token):
  verify token, `const newTok = reg.rotateToken(id)`; if undefined → 404; else
  `json(res, 200, { token: newTok })`. Add `TENANT_DISABLED`→403 mapping.
- [ ] Step 4: cloud test: register remote → token A. `POST /t/<id>/rotate` with
  Bearer A → 200 + new token B. `POST /t/<id>/mcp` with A → 401 (rotated),
  with B → 200. (Disabling is covered at registry level; optionally a cloud test
  calling the webhook? skip — registry unit test suffices.)
- [ ] Step 5: `npm test` green; build clean.
- [ ] Step 6: commit `feat(cloud): add token rotation + tenant disable`

---

### Task 4 — streaming (O(1)) request log

**Files:** `src/cloud/request-log.ts`, `test/cloud/request-log.test.ts` (extend).

**Why:** current `appendLog` re-reads the whole file every append. Fine at 1000
lines but wasteful. Replace with a per-path in-memory ring.

- [ ] Step 1: refactor `request-log.ts` to keep a module-level
  `Map<string, string[]>` ring keyed by `logPath`. On first append for a path,
  load existing lines into the ring (once). On each append: push the line, if
  `ring.length > CAP` shift; rewrite the file with `ring.join("\n") + "\n"`.
  Keep the exported `appendLog(logPath, entry)` signature unchanged.
- [ ] Step 2: add a test asserting many appends are still capped at 1000 and that
  the ring is reused (e.g., 2000 appends → 1000 lines, last `n` = 1999, first = 1000).
- [ ] Step 3: `npm test` green; build clean.
- [ ] Step 4: commit `perf(cloud): stream-capped request log via in-memory ring`

---

### Task 5 — Docker + CI

**Files:** `Dockerfile` (new), `.github/workflows/ci.yml` (new).

- [ ] Step 1: `Dockerfile` (multi-stage, `node:20-alpine`):
  - build: `npm ci` + `npm run build`.
  - runtime: `npm ci --omit=dev` (or copy prod node_modules), `COPY bin ./bin`,
    `COPY package.json ./`, `EXPOSE 8080`, `ENV PORT=8080 DATA_DIR=/app/data`,
    `VOLUME ["/app/data"]`, `CMD ["node","bin/cloud/mcpsense-cloud.js"]`.
- [ ] Step 2: `.github/workflows/ci.yml`: on push + PR to `main`:
  `actions/checkout@v4`, `actions/setup-node@v4` (node 20, npm cache),
  `npm ci`, `npm run build`, `npm test`.
- [ ] Step 3: verify yaml is syntactically valid (`node -e` parse optional). Build
  cleanliness already covered by `npm run build`.
- [ ] Step 4: commit `ci: add Dockerfile and GitHub Actions CI`

---

### Task 6 — production deploy docs + landing mention

**Files:** `README.md` (expand Cloud section), `public/index.html` (mention Cloud).

- [ ] Step 1: expand the README "MCPSense Cloud (local dev)" section into a full
  "MCPSense Cloud" section with:
  - A table of env vars: `PORT`, `REGISTER_KEY`, `STRIPE_SECRET_KEY`,
    `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID`, `REMOTE_EGRESS_ALLOWLIST`,
    `DATA_DIR`.
  - Production notes: SSRF allowlist is REQUIRED for any public deploy; `REGISTER_KEY`
    is REQUIRED for stdio; `paid` is enforced on the bridge when `STRIPE_SECRET_KEY`
    is set; tokens can be rotated via `POST /t/<id>/rotate` and tenants disabled.
  - Docker quickstart (`docker build -t mcpsense-cloud . && docker run -e PORT=8080
    -e REGISTER_KEY=... -e REMOTE_EGRESS_ALLOWLIST=api.example.com -v $(pwd)/data:/app/data -p 8080:8080 mcpsense-cloud`).
  - Process-manager snippet (pm2 or systemd).
- [ ] Step 2: in `public/index.html`, add a short "MCPSense Cloud" blurb + link to
  the README section.
- [ ] Step 3: `npm run build` clean (html change doesn't affect build; just sanity).
- [ ] Step 4: commit `docs: production deploy guide + landing mention for Cloud`

---

## Self-review notes
- Security: SSRF guard + `REGISTER_KEY` + per-tenant Bearer + token rotation +
  disable together make public deployment defensible for a v1.
- `paid` enforcement intentionally opt-in via `STRIPE_SECRET_KEY`.
- Persistence remains JSON-file (single instance) — documented as v2 work.
- Out of scope kept out: full user-account dashboard, horizontal scaling,
  enterprise SLA, DNS-rebinding protection (noted in egress docs).
