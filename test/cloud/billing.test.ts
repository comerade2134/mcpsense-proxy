import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startCloudServer } from "../../src/cloud/cloud-server.js";
import { TenantRegistry } from "../../src/cloud/tenant-registry.js";
import { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Stripe } from "stripe";

let srv: Server;
let base: string;
const SECRET = "sk_test_xxx";
const WHSEC = "whsec_test";

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function signedPayload(event: object, secret: string): Promise<{ raw: string; sig: string }> {
  const stripe = new Stripe(SECRET);
  const raw = JSON.stringify(event);
  const sig = stripe.webhooks.generateTestHeaderString({ payload: raw, secret });
  return { raw, sig };
}

beforeAll(async () => {
  srv = startCloudServer({ port: 0, stripeSecretKey: SECRET, stripeWebhookSecret: WHSEC, egressAllowlist: ["127.0.0.1"] });
  await new Promise<void>((r) => srv.listen(0, r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
afterAll(() => srv?.close());

describe("billing", () => {
  it("webhook with valid signature flips tenant to paid", async () => {
    const reg = await post("/register", { type: "remote", url: "http://127.0.0.1:9/mcp" });
    const rj = await reg.json();
    const tenantId = rj.tenantId;
    const event = { id: "evt_1", type: "checkout.session.completed", data: { object: { client_reference_id: tenantId } } };
    const { raw, sig } = await signedPayload(event, WHSEC);
    const res = await fetch(base + "/stripe/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": sig },
      body: raw,
    });
    expect(res.status).toBe(200);
    // The server persisted the flip; reload from disk to verify.
    expect(new TenantRegistry().findById(tenantId)?.paid).toBe(true);
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
