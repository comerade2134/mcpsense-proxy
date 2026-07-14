import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TenantRegistry, verifyToken } from "./tenant-registry.js";
import { createProxyHandler } from "../proxy-server.js";
import { appendLog } from "./request-log.js";
import { logger } from "../logger.js";

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
      if (msg === "BAD_JSON") return json(res, 400, { error: "invalid json" });
      logger.error({ err: msg }, "unhandled cloud request error");
      return json(res, 500, { error: "internal error" });
    }
  });
  // NOTE: do NOT call server.listen() here. The caller (the test or the
  // `mcpsense-cloud` CLI) calls server.listen(port). Auto-listening here would
  // double-bind because the test also calls listen().
  return server;
}
