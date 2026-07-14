#!/usr/bin/env node
import { startCloudServer } from "./cloud-server.js";
import { logger } from "../logger.js";

const port = Number.parseInt(process.env.PORT ?? "8080", 10) || 8080;
const registerKey = process.env.REGISTER_KEY;
const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

const server = startCloudServer({ port, registerKey, stripeSecretKey, stripeWebhookSecret });
server.listen(port);
server.on("error", (err) => {
  logger.error({ err }, "MCPSense Cloud failed to start");
  process.exit(1);
});
server.on("listening", () => logger.info({ port }, "MCPSense Cloud listening"));
