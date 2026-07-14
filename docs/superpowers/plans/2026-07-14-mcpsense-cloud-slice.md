# MCPSense Cloud — Thin Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a multi-tenant "Cloud" mode to mcpsense-proxy: register a remote legacy backend via a public API, bridge it with a 2026-07-28 client through an isolated session, log requests per tenant, and flip a `paid` flag via a Stripe test-mode webhook.

**Architecture:** One long-running Node process (`src/cloud/`) owns a `TenantRegistry` that holds one warm `LegacyClientManager` per tenant (reusing the existing proxy front-end via `createProxyHandler` plus a new optional `onRequest` log hook). `remote` registration is public; `stdio` is `REGISTER_KEY`-gated to prevent RCE. State persists to `data/tenants.json` + `data/logs/<id>.jsonl`.

**Tech Stack:** TypeScript, Node `http`, `@modelcontextprotocol/sdk` (already a dep), `stripe` (new dep), `vitest` (already a devDep). No database.

---

## File Structure

- Create: `src/cloud/tenant-registry.ts` — tenant records, SHA-256 token hashing + constant-time verify, register (remote public / stdio gated), JSON persistence, lazy manager bootstrap.
- Create: `src/cloud/request-log.ts` — append capped JSONL per tenant.
- Create: `src/cloud/cloud-server.ts` — `http` server: `/register`, `/t/<id>/mcp`, `/t/<id>/logs`, `/billing/checkout`, `/stripe/webhook`, `/health`.
- Create: `src/cloud/mcpsense-cloud.ts` — CLI entry; new `bin/mcpsense-cloud` (compiled from `src/mcpsense-cloud.ts`).
- Modify: `src/proxy-server.ts` — `createProxyHandler` gains optional `onRequest` callback.
- Modify: `package.json` — add `bin.mcpsense-cloud` + `stripe` dependency.
- Test: `test/cloud/registry.test.ts`, `test/cloud/request-log.test.ts`, `test/cloud/cloud-server.test.ts`, and a proxy-server hook test appended to `test/proxy.test.ts`.
- Fixtures reused: `test/fixture-legacy-server.ts` (stdio) and `test/fixture-remote-legacy-server.ts` (remote HTTP).

---

### Task 1: Add `onRequest` hook to `createProxyHandler`

**Files:**
- Modify: `src/proxy-server.ts` (signature of `createProxyHandler` + handler return)
- Test: `test/proxy.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/proxy.test.ts`:

```ts
import { LegacyClientManager } from "../src/legacy-client.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createProxyHandler } from "../src/proxy-server.js";

describe("createProxyHandler onRequest hook", () => {
  it("invokes onRequest with method, status, latencyMs on a successful call", async () => {
    const fixture = fileURLToPath(new URL("./fixture-legacy-server.ts", import.meta.url));
    const manager = new LegacyClientManager(new StdioClientTransport({ command: "npx", args: ["tsx", fixture] }));
    await manager.bootstrap();
    const events: unknown[] = [];
    const handler = createProxyHandler(manager, { onRequest: (e) => events.push(e) });
    const server = createServer(handler);
    await new Promise<void>((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;

    const res = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json", "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": "greet" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "greet", arguments: { name: "LO" } } }),
    });
    await res.json();
    await new Promise((r) => server.close(r));
    expect(events.length).toBe(1);
    expect((events[0] as { method: string }).method).toBe("tools/call");
    expect((events[0] as { status: number }).status).toBe(200);
    expect(typeof (events[0] as { latencyMs: number }).latencyMs).toBe("number");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:\Users\abdu\Desktop\mcpsense-proxy; npm test 2>&1 | Select-Object -Last 15`
Expected: the new test FAILS (`createProxyHandler` does not accept a 2nd argument / `onRequest` never fires).

- [ ] **Step 3: Write minimal implementation**

In `src/proxy-server.ts`, change the export signature and the returned handler so the status is tracked and `onRequest` fires once per request. Replace the existing `export function createProxyHandler(manager: LegacyClientManager) {` line and the `return async function handle(req, res) { ... };` body with:

```ts
export function createProxyHandler(
  manager: LegacyClientManager,
  opts: { onRequest?: (e: { method: string; status: number; latencyMs: number; name?: string }) => void } = {},
) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const traceparent = req.headers["traceparent"];
    const traceHeaders: Record<string, string> = traceparent ? { traceparent: String(traceparent) } : {};

    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", ...traceHeaders });
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

    const startTime = Date.now();
    const isNotification = NOTIFICATION_METHODS.has(body.method) || body.id === undefined;
    const name = (body.params?.name ?? body.params?.uri) as string | undefined;

    let statusCode = 200;
    try {
      validateHeaders(req, body);
      await dispatch(body, manager);
      if (isNotification) {
        logger.info({ method: body.method, latencyMs: Date.now() - startTime }, "notification handled");
        statusCode = 202;
        sendJson(res, 202, traceHeaders);
      } else {
        logger.info({ method: body.method, name, latencyMs: Date.now() - startTime, status: "success" }, "request bridged");
        sendJson(res, 200, { jsonrpc: "2.0", id: body.id ?? null, result: await dispatchResult(body, manager) }, { "Mcp-Method": body.method, ...traceHeaders });
      }
    } catch (err) {
      const rpcErr = err instanceof RpcError ? err : new RpcError(-32603, (err as Error).message ?? "Internal error");
      statusCode = rpcErr.code === -32601 ? 404 : rpcErr.code === -32001 ? 400 : 500;
      logger.error({ method: body.method, latencyMs: Date.now() - startTime, code: rpcErr.code, message: rpcErr.message }, "request failed");
      if (isNotification) {
        sendJson(res, 202, traceHeaders);
      } else {
        sendJson(res, statusCode, { jsonrpc: "2.0", id: body.id ?? null, error: { code: rpcErr.code, message: rpcErr.message } }, { "Mcp-Method": body.method, ...traceHeaders });
      }
    }

    opts.onRequest?.({ method: body.method, status: statusCode, latencyMs: Date.now() - startTime, name });
  };
}
```

Because the success path now computes `result` separately, add this helper near `dispatch`:

```ts
async function dispatchResult(req: JsonRpcRequest, manager: LegacyClientManager) {
  return dispatch(req, manager);
}
```

(Kept as a thin wrapper so the existing `dispatch` is unchanged.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | Select-Object -Last 15`
Expected: all tests PASS (including the new `onRequest` test).

- [ ] **Step 5: Commit**

```bash
git add src/proxy-server.ts test/proxy.test.ts
git commit -m "feat(cloud): add optional onRequest log hook to createProxyHandler"
```

---

### Task 2: `request-log.ts` — capped JSONL per tenant

**Files:**
- Create: `src/cloud/request-log.ts`
- Test: `test/cloud/request-log.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/cloud/request-log.test.ts`:

```ts
import { appendLog } from "../../src/cloud/request-log.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("request-log", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcpsense-log-"));
  const p = join(dir, "t_x.jsonl");
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("appends JSONL entries and caps at 1000 lines", () => {
    for (let i = 0; i < 1005; i++) appendLog(p, { n: i });
    const lines = readFileSync(p, "utf8").trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(1000);
    expect(JSON.parse(lines[lines.length - 1]).n).toBe(1004);
    expect(JSON.parse(lines[0]).n).toBe(5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | Select-Object -Last 12`
Expected: FAIL (`cannot find module .../request-log.js`).

- [ ] **Step 3: Write minimal implementation**

Create `src/cloud/request-log.ts`:

```ts
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const CAP = 1000;

export function appendLog(logPath: string, entry: object): void {
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, JSON.stringify(entry) + "\n");
  cap(logPath);
}

function cap(p: string): void {
  if (!existsSync(p)) return;
  const lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
  if (lines.length > CAP) {
    writeFileSync(p, lines.slice(-CAP).join("\n") + "\n");
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | Select-Object -Last 12`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cloud/request-log.ts test/cloud/request-log.test.ts
git commit -m "feat(cloud): add capped JSONL request logger"
```

---

### Task 3: `tenant-registry.ts` — records, hashing, gated register, persistence

**Files:**
- Create: `src/cloud/tenant-registry.ts`
- Test: `test/cloud/registry.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/cloud/registry.test.ts`:

```ts
import { TenantRegistry, verifyToken, hashToken } from "../../src/cloud/tenant-registry.js";

describe("TenantRegistry", () => {
  it("registers a remote tenant publicly and returns a plaintext token", async () => {
    const reg = new TenantRegistry();
    const { record, token } = await reg.register({ type: "remote", url: "http://127.0.0.1:9/mcp" });
    expect(record.kind).toBe("remote");
    expect(record.endpoint).toBe(`/t/${record.id}/mcp`);
    expect(record.paid).toBe(false);
    // token verifies against stored hash
    expect(verifyToken(record.tokenHash, token)).toBe(true);
    expect(verifyToken(record.tokenHash, "wrong")).toBe(false);
  });

  it("rejects stdio registration without REGISTER_KEY (403 path)", async () => {
    const reg = new TenantRegistry(); // no key
    await expect(reg.register({ type: "stdio", command: "echo", args: ["x"] })).rejects.toThrow("FORBIDDEN_STDIO");
  });

  it("allows stdio registration when REGISTER_KEY matches", async () => {
    const reg = new TenantRegistry("secret-key");
    const { record } = await reg.register({ type: "stdio", command: "echo", args: ["x"] }, "secret-key");
    expect(record.kind).toBe("stdio");
  });

  it("sets paid flag and hashToken is stable length", () => {
    expect(hashToken("abc").length).toBe(64);
    const reg = new TenantRegistry();
    reg.setPaid("t_doesnotexist", true); // no-op, must not throw
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | Select-Object -Last 12`
Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

Create `src/cloud/tenant-registry.ts`:

```ts
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LegacyClientManager } from "../legacy-client.js";
import { RemoteHttpClientTransport } from "../remote-http-transport.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

const DATA_DIR = join(process.cwd(), "data");
const TENANTS_FILE = join(DATA_DIR, "tenants.json");

export interface TenantRecord {
  id: string;
  tokenHash: string;
  kind: "remote" | "stdio";
  remoteUrl?: string;
  command?: string;
  args?: string[];
  endpoint: string;
  paid: boolean;
  createdAt: number;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function verifyToken(storedHash: string, token: string): boolean {
  const given = hashToken(token);
  const a = Buffer.from(storedHash, "hex");
  const b = Buffer.from(given, "hex");
  if (a.length !== b.length) return false; // guard: timingSafeEqual throws on length mismatch
  return timingSafeEqual(a, b);
}

function genId(): string {
  return "t_" + createHash("sha256").update(Math.random().toString() + Date.now()).digest("hex").slice(0, 12);
}

function randomToken(): string {
  return createHash("sha256").update(Math.random().toString() + Date.now()).digest("hex").slice(0, 32);
}

export class TenantRegistry {
  private tenants: TenantRecord[] = [];
  private managers = new Map<string, LegacyClientManager>();

  constructor(private readonly registerKey?: string) {
    this.load();
  }

  private load(): void {
    if (existsSync(TENANTS_FILE)) {
      try {
        this.tenants = JSON.parse(readFileSync(TENANTS_FILE, "utf8")).tenants ?? [];
      } catch {
        this.tenants = [];
      }
    }
  }

  private save(): void {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(TENANTS_FILE, JSON.stringify({ tenants: this.tenants }, null, 2));
  }

  async register(
    input: { type: "remote"; url: string } | { type: "stdio"; command: string; args?: string[] },
    providedKey?: string,
  ): Promise<{ record: TenantRecord; token: string }> {
    if (input.type === "stdio" && (!this.registerKey || providedKey !== this.registerKey)) {
      throw new Error("FORBIDDEN_STDIO");
    }
    const id = genId();
    const token = randomToken();
    const record: TenantRecord = {
      id,
      tokenHash: hashToken(token),
      kind: input.type,
      endpoint: `/t/${id}/mcp`,
      paid: false,
      createdAt: Math.floor(Date.now() / 1000),
      ...(input.type === "remote"
        ? { remoteUrl: input.url }
        : { command: input.command, args: input.args ?? [] }),
    };
    this.tenants.push(record);
    this.save();

    const transport: Transport =
      input.type === "remote"
        ? new RemoteHttpClientTransport(input.url)
        : new StdioClientTransport({ command: input.command, args: input.args ?? [] });
    const manager = new LegacyClientManager(transport);
    await manager.bootstrap();
    this.managers.set(id, manager);
    return { record, token };
  }

  findById(id: string): TenantRecord | undefined {
    return this.tenants.find((t) => t.id === id);
  }

  getManager(id: string): LegacyClientManager | undefined {
    return this.managers.get(id);
  }

  async ensureManager(id: string): Promise<LegacyClientManager | undefined> {
    const existing = this.managers.get(id);
    if (existing) return existing;
    const rec = this.findById(id);
    if (!rec) return undefined;
    const transport: Transport =
      rec.kind === "remote"
        ? new RemoteHttpClientTransport(rec.remoteUrl!)
        : new StdioClientTransport({ command: rec.command!, args: rec.args ?? [] });
    const manager = new LegacyClientManager(transport);
    await manager.bootstrap();
    this.managers.set(id, manager);
    return manager;
  }

  setPaid(id: string, paid: boolean): void {
    const rec = this.findById(id);
    if (!rec) return;
    rec.paid = paid;
    this.save();
  }

  logPath(id: string): string {
    return join(DATA_DIR, "logs", `${id}.jsonl`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | Select-Object -Last 12`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cloud/tenant-registry.ts test/cloud/registry.test.ts
git commit -m "feat(cloud): add TenantRegistry with gated stdio + token hashing"
```

---

### Task 4: `cloud-server.ts` — routes + token-checked tenant bridging

**Files:**
- Create: `src/cloud/cloud-server.ts`
- Test: `test/cloud/cloud-server.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/cloud/cloud-server.test.ts`:

```ts
import { startCloudServer } from "../../src/cloud/cloud-server.js";
import { startRemoteLegacyFixture } from "../fixture-remote-legacy-server.js";
import { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { existsSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";

let srv: Server;
let base: string;
let remote: Awaited<ReturnType<typeof startRemoteLegacyFixture>>;
let dataDir: string;

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  dataDir = join(process.cwd(), "data");
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  remote = await startRemoteLegacyFixture();
  srv = startCloudServer({ port: 0, registerKey: "rk" });
  await new Promise<void>((r) => srv.listen(0, r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});

afterAll(() => {
  srv?.close();
  remote?.server.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("cloud server", () => {
  it("registers a remote backend and bridges it with a token", async () => {
    const reg = await post("/register", { type: "remote", url: remote.url });
    const rj = await reg.json();
    expect(rj.endpoint).toMatch(/^\/t\//);
    const token = rj.token;

    const disc = await post(rj.endpoint, { jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } } }, { "mcp-protocol-version": "2026-07-28", "mcp-method": "server/discover", authorization: `Bearer ${token}` });
    expect(disc.status).toBe(200);
    expect((await disc.json()).result.serverInfo.name).toBe("remote-legacy");

    // wrong token -> 401
    const bad = await post(rj.endpoint, { jsonrpc: "2.0", id: 1, method: "server/discover", params: {} }, { "mcp-method": "server/discover", authorization: "Bearer nope" });
    expect(bad.status).toBe(401);
  });

  it("rejects stdio register without key (403) and allows with key", async () => {
    const noKey = await post("/register", { type: "stdio", command: "echo", args: ["x"] });
    expect(noKey.status).toBe(403);
    const withKey = await post("/register", { type: "stdio", command: "echo", args: ["x"] }, { "x-register-key": "rk" });
    expect(withKey.status).toBe(200);
  });

  it("records request logs retrievable via /logs", async () => {
    const reg = await post("/register", { type: "remote", url: remote.url });
    const { endpoint, token } = await reg.json();
    await post(endpoint, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list", authorization: `Bearer ${token}` });
    if (!existsSync(join(dataDir, "logs"))) mkdirSync(join(dataDir, "logs"), { recursive: true });
    const logsRes = await post(endpoint.replace("/mcp", "/logs"), {}, { authorization: `Bearer ${token}` });
    const lj = await logsRes.json();
    expect(lj.logs.length).toBeGreaterThan(0);
    expect(lj.logs[lj.logs.length - 1].method).toBe("tools/list");
  });

  it("health endpoint", async () => {
    const h = await fetch(base + "/health");
    expect(h.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | Select-Object -Last 12`
Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

Create `src/cloud/cloud-server.ts`:

```ts
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TenantRegistry, verifyToken } from "./tenant-registry.js";
import { createProxyHandler } from "../proxy-server.js";
import { appendLog } from "./request-log.js";

export interface CloudOptions {
  port: number;
  registerKey?: string;
  stripeSecretKey?: string;
  stripeWebhookSecret?: string;
}

function json(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...extra });
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("BAD_JSON"));
      }
    });
    req.on("error", reject);
  });
}

function bearer(req: IncomingMessage): string | undefined {
  const h = req.headers["authorization"];
  if (typeof h === "string" && h.startsWith("Bearer ")) return h.slice(7);
  return undefined;
}

async function handleRegister(req: IncomingMessage, res: ServerResponse, reg: TenantRegistry, opts: CloudOptions): Promise<void> {
  const body = await readJson(req);
  const key = (req.headers["x-register-key"] as string) ?? (body.registerKey as string | undefined);
  if (body.type === "remote") {
    const { record, token } = await reg.register({ type: "remote", url: body.url as string }, key);
    return json(res, 200, { tenantId: record.id, endpoint: record.endpoint, token });
  }
  if (body.type === "stdio") {
    const { record, token } = await reg.register({ type: "stdio", command: body.command as string, args: (body.args as string[]) ?? [] }, key);
    return json(res, 200, { tenantId: record.id, endpoint: record.endpoint, token });
  }
  return json(res, 400, { error: "invalid type" });
}

async function handleTenantMcp(req: IncomingMessage, res: ServerResponse, reg: TenantRegistry, id: string): Promise<void> {
  const rec = reg.findById(id);
  if (!rec) throw new Error("NOT_FOUND");
  const token = bearer(req);
  if (!token || !verifyToken(rec.tokenHash, token)) throw new Error("UNAUTHORIZED");
  const manager = await reg.ensureManager(id);
  if (!manager) throw new Error("NOT_FOUND");
  const handler = createProxyHandler(manager, {
    onRequest: (e) => appendLog(reg.logPath(id), { ts: Math.floor(Date.now() / 1000), ...e }),
  });
  await handler(req, res);
}

async function handleTenantLogs(req: IncomingMessage, res: ServerResponse, reg: TenantRegistry, id: string): Promise<void> {
  const rec = reg.findById(id);
  if (!rec) throw new Error("NOT_FOUND");
  const token = bearer(req);
  if (!token || !verifyToken(rec.tokenHash, token)) throw new Error("UNAUTHORIZED");
  const p = reg.logPath(id);
  const lines = existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  return json(res, 200, { logs: lines.slice(-100) });
}

async function handleCheckout(req: IncomingMessage, res: ServerResponse, reg: TenantRegistry, opts: CloudOptions): Promise<void> {
  if (!opts.stripeSecretKey) throw new Error("NO_STRIPE");
  const body = await readJson(req);
  const { default: Stripe } = await import("stripe");
  const stripe = new Stripe(opts.stripeSecretKey);
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    client_reference_id: body.tenantId as string,
    line_items: [{ price: (body.priceId as string) ?? process.env.STRIPE_PRICE_ID, quantity: 1 }],
    success_url: (body.successUrl as string) ?? "https://comerade2134.github.io/mcpsense-proxy/?paid=1",
  });
  return json(res, 200, { url: session.url });
}

async function handleStripeWebhook(req: IncomingMessage, res: ServerResponse, reg: TenantRegistry, opts: CloudOptions): Promise<void> {
  if (!opts.stripeWebhookSecret || !opts.stripeSecretKey) throw new Error("NO_STRIPE");
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  const raw = await new Promise<Buffer>((resolve, reject) => {
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
  const sig = req.headers["stripe-signature"] as string;
  const { default: Stripe } = await import("stripe");
  const stripe = new Stripe(opts.stripeSecretKey);
  let event: import("stripe").Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(raw, sig, opts.stripeWebhookSecret);
  } catch {
    throw new Error("BAD_SIGNATURE");
  }
  if (event.type === "checkout.session.completed") {
    const session = event.data.object as { client_reference_id?: string | null };
    if (session.client_reference_id) reg.setPaid(session.client_reference_id, true);
  }
  return json(res, 200, { received: true });
}

export function startCloudServer(opts: CloudOptions): Server {
  mkdirSync(join(process.cwd(), "data", "logs"), { recursive: true });
  const reg = new TenantRegistry(opts.registerKey);
  const server = createServer(async (req, res) => {
    const url = (req.url ?? "/").split("?")[0];
    const method = req.method ?? "GET";
    try {
      if (method === "GET" && url === "/health") return json(res, 200, { ok: true });
      if (method === "POST" && url === "/register") return await handleRegister(req, res, reg, opts);
      if (method === "POST" && url === "/billing/checkout") return await handleCheckout(req, res, reg, opts);
      if (method === "POST" && url === "/stripe/webhook") return await handleStripeWebhook(req, res, reg, opts);
      const m = /^\/t\/([^/]+)\/(mcp|logs)$/.exec(url);
      if (m && m[2] === "mcp" && method === "POST") return await handleTenantMcp(req, res, reg, m[1]);
      if (m && m[2] === "logs" && method === "GET") return await handleTenantLogs(req, res, reg, m[1]);
      return json(res, 404, { error: "not found" });
    } catch (e) {
      const msg = (e as Error).message;
      if (msg === "FORBIDDEN_STDIO") return json(res, 403, { error: "stdio registration requires REGISTER_KEY" });
      if (msg === "UNAUTHORIZED") return json(res, 401, { error: "unauthorized" });
      if (msg === "NOT_FOUND") return json(res, 404, { error: "tenant not found" });
      if (msg === "NO_STRIPE") return json(res, 503, { error: "billing not configured" });
      if (msg === "BAD_SIGNATURE") return json(res, 400, { error: "invalid signature" });
      return json(res, 500, { error: msg });
    }
  });
  server.listen(opts.port);
  return server;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | Select-Object -Last 12`
Expected: PASS (all cloud-server tests green). Note: `stripe` import is dynamic, so tests pass even before `stripe` is installed because no test hits billing routes yet — install it in Task 6.

- [ ] **Step 5: Commit**

```bash
git add src/cloud/cloud-server.ts test/cloud/cloud-server.test.ts
git commit -m "feat(cloud): add multi-tenant cloud server with token-checked bridging"
```

---

### Task 5: Stripe test-mode billing (checkout + webhook)

**Files:**
- Modify: `package.json` (add `stripe` dependency, `bin.mcpsense-cloud`)
- Modify: `src/cloud/mcpsense-cloud.ts` (CLI entry)
- Test: `test/cloud/billing.test.ts`

- [ ] **Step 1: Install stripe and write the failing test**

Run: `cd C:\Users\abdu\Desktop\mcpsense-proxy; npm install stripe@^17.2.0`

Create `test/cloud/billing.test.ts`:

```ts
import { startCloudServer } from "../../src/cloud/cloud-server.js";
import { TenantRegistry } from "../../src/cloud/tenant-registry.js";
import { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Stripe } from "stripe";

let srv: Server;
let base: string;
const SECRET = "sk_test_xxx";
const WHSEC = "whsec_test";

async function signedPayload(event: object, secret: string): Promise<{ raw: string; sig: string }> {
  const stripe = new Stripe(SECRET);
  const raw = JSON.stringify(event);
  const sig = stripe.webhooks.generateTestHeaderString({ payload: raw, secret });
  return { raw, sig };
}

beforeAll(async () => {
  srv = startCloudServer({ port: 0, stripeSecretKey: SECRET, stripeWebhookSecret: WHSEC });
  await new Promise<void>((r) => srv.listen(0, r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
afterAll(() => srv?.close());

describe("billing", () => {
  it("webhook with valid signature flips tenant to paid", async () => {
    const reg = new TenantRegistry();
    const { record } = await reg.register({ type: "remote", url: "http://127.0.0.1:9/mcp" });
    const event = { id: "evt_1", type: "checkout.session.completed", data: { object: { client_reference_id: record.id } } };
    const { raw, sig } = await signedPayload(event, WHSEC);
    const res = await fetch(base + "/stripe/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": sig },
      body: raw,
    });
    expect(res.status).toBe(200);
    expect(reg.findById(record.id)?.paid).toBe(true);
  });

  it("webhook with bad signature is rejected", async () => {
    const res = await fetch(base + "/stripe/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": "bad" },
      body: JSON.stringify({ id: "x" }),
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails without the webhook wiring** (stripe is installed now; if `handleStripeWebhook` already exists from Task 4 it may pass — that's fine. If it errors on missing `stripe` types, install resolved it.)

Run: `npm test 2>&1 | Select-Object -Last 12`
Expected: the billing tests PASS (Task 4 already wired the handler using the now-installed `stripe`). If they fail, fix `handleStripeWebhook` per Task 4 code (it is complete).

- [ ] **Step 3: Add bin entry + CLI**

In `package.json`, add to `bin`:
```json
"bin": {
  "mcpsense-proxy": "bin/mcpsense-proxy.js",
  "mcpsense-cloud": "bin/mcpsense-cloud.js"
},
```
and ensure `dependencies` includes `"stripe": "^17.2.0"`.

Create `src/cloud/mcpsense-cloud.ts`:

```ts
#!/usr/bin/env node
import { startCloudServer } from "./cloud/cloud-server.js";
import { logger } from "./logger.js";

const port = Number.parseInt(process.env.PORT ?? "8080", 10);
const registerKey = process.env.REGISTER_KEY;
const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

const server = startCloudServer({ port, registerKey, stripeSecretKey, stripeWebhookSecret });
server.on("listening", () => logger.info({ port }, "MCPSense Cloud listening"));
```

- [ ] **Step 4: Build and smoke-run the cloud server**

Run: `npm run build`
Then in a separate PowerShell:
```powershell
$env:REGISTER_KEY="rk"; $env:PORT="8099"; node bin/mcpsense-cloud.js
```
In another terminal:
```powershell
curl.exe -s -X POST http://127.0.0.1:8099/register -H "content-type: application/json" -d '{"type":"remote","url":"https://example.com/mcp"}'
```
Expected: JSON with `tenantId`, `endpoint`, `token` (remote is public even without key).

- [ ] **Step 5: Commit**

```bash
git add package.json src/cloud/mcpsense-cloud.ts test/cloud/billing.test.ts
git commit -m "feat(cloud): add Stripe test-mode checkout + webhook, cloud CLI bin"
```

---

### Task 6: README + final green suite

**Files:**
- Modify: `README.md` (add a "MCPSense Cloud (local dev)" section)

- [ ] **Step 1: Add a Cloud dev section to README**

Append before `## License`:

```markdown
## MCPSense Cloud (local dev)

The same proxy, multi-tenant. Run the cloud server:

\`\`\`bash
npm run build
REGISTER_KEY=your-dev-key PORT=8080 node bin/mcpsense-cloud.js
\`\`\`

- `POST /register` with `{ "type": "remote", "url": "..." }` is **public** and safe (only outbound HTTP).
- `POST /register` with `{ "type": "stdio", "command": "...", "args": [...] }` requires the `REGISTER_KEY` header/field (prevents RCE).
- Bridge a tenant: `POST /t/<tenantId>/mcp` with `Authorization: Bearer <token>`.
- View logs: `GET /t/<tenantId>/logs` (token required).
- Billing (test mode): `POST /billing/checkout`, `POST /stripe/webhook` (needs `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`).

State lives in `data/tenants.json` + `data/logs/<tenantId>.jsonl`.
```

- [ ] **Step 2: Run the full suite**

Run: `npm test 2>&1 | Select-Object -Last 8`
Expected: all tests PASS (proxy hook, request-log, registry, cloud-server, billing).

- [ ] **Step 3: Build clean**

Run: `npm run build 2>&1 | Select-Object -Last 5`
Expected: no TS errors.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document MCPSense Cloud local-dev mode"
```

---

## Self-review notes (already applied)

- **Spec coverage:** RCE guard (`stdio` gated) — Task 3/4 ✅. `remote` public — Task 4 ✅. Token hashing + constant-time verify with length guard — Task 3 ✅. Per-tenant isolation (`Bearer` on `/t/<id>/mcp`) — Task 4 ✅. `onRequest` hook non-invasive — Task 1 ✅. JSONL capped ring — Task 2 ✅. Stripe test-mode checkout + webhook via `client_reference_id` — Task 5 ✅. Tests for each — included.
- **No placeholders:** every code step is complete.
- **Type consistency:** `TenantRegistry.register` signature, `CloudOptions`, `createProxyHandler(manager, {onRequest})` match across tasks. `verifyToken` exported from `tenant-registry.ts` and imported in `cloud-server.ts`.
- **Out of scope respected:** no auth UI, dashboard, DB, containers, SSRF filter (noted in spec).
