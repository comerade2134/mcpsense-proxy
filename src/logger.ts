import pino from "pino";

export const logger = pino({
  level: process.env.MCPSENSE_LOG_LEVEL ?? "info",
});
