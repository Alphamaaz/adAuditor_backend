import "dotenv/config";
import { initSentry, Sentry } from "./lib/sentry.js";
initSentry();
import { initializeAuditQueueProcessors } from "./queues/auditQueue.js";
import { closeAllQueues, getDriver } from "./queues/jobQueue.js";

// Capture unhandled rejections + uncaught exceptions in the worker.
process.on("unhandledRejection", (err) => {
  console.error("[worker] unhandledRejection", err);
  if (process.env.SENTRY_DSN) Sentry.captureException(err);
});
process.on("uncaughtException", (err) => {
  console.error("[worker] uncaughtException", err);
  if (process.env.SENTRY_DSN) Sentry.captureException(err);
});

/**
 * Worker entry point. Run as a separate process from the API:
 *   npm run worker     (production)
 *   npm run worker:dev (nodemon)
 *
 * Only useful when JOB_QUEUE_DRIVER=bull. In inline mode, processors run
 * inside the API process — this script will warn and exit.
 */

const driver = getDriver();

if (driver !== "bull") {
  // eslint-disable-next-line no-console
  console.warn(
    "[worker] JOB_QUEUE_DRIVER is not 'bull'. Worker not needed in inline mode. Exiting."
  );
  process.exit(0);
}

// eslint-disable-next-line no-console
console.log("[worker] Starting audit queue worker (driver=bull)...");

initializeAuditQueueProcessors();

// eslint-disable-next-line no-console
console.log("[worker] Processors registered. Waiting for jobs.");

const shutdown = async (signal) => {
  // eslint-disable-next-line no-console
  console.log(`[worker] Received ${signal}. Draining queues...`);
  try {
    await closeAllQueues();
    process.exit(0);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("[worker] Error during shutdown", error);
    process.exit(1);
  }
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Keep the event loop alive even when no jobs are pending.
setInterval(() => {}, 1 << 30);
