import "dotenv/config";
import app from "./app.js";
import { prisma } from "./lib/prisma.js";
import { reconcileStuckAuditsOnce } from "./jobs/stuckAuditReconciliation.js";
import { assertStorageIsHealthy } from "./lib/storage/index.js";

const port = process.env.PORT || 5000;
const isProd = process.env.NODE_ENV === "production";

// ── Boot-time configuration validation ─────────────────────────────────────
const validateBootConfig = () => {
  const errors = [];

  if (!process.env.DATABASE_URL) {
    errors.push("DATABASE_URL is required");
  }

  // Billing — if Stripe key is set, webhook secret MUST be set too.
  if (process.env.STRIPE_SECRET_KEY && !process.env.STRIPE_WEBHOOK_SECRET) {
    errors.push(
      "STRIPE_SECRET_KEY is set but STRIPE_WEBHOOK_SECRET is missing. " +
        "The webhook handler will reject Stripe events and customer subscriptions " +
        "will silently fail to sync. Set both or neither."
    );
  }

  // Production: warn about missing optional services (non-fatal until configured).
  if (isProd) {
    if (!process.env.STRIPE_SECRET_KEY) {
      // eslint-disable-next-line no-console
      console.warn(
        "[boot] STRIPE_SECRET_KEY is not set. Billing features will be unavailable."
      );
    }
    if (!process.env.SENTRY_DSN) {
      // eslint-disable-next-line no-console
      console.warn(
        "[boot] SENTRY_DSN is not set. Production errors will not be captured."
      );
    }
    if (process.env.JOB_QUEUE_DRIVER !== "bull") {
      // eslint-disable-next-line no-console
      console.warn(
        "[boot] JOB_QUEUE_DRIVER is not 'bull' in production. " +
          "Inline mode loses jobs on restart. Set JOB_QUEUE_DRIVER=bull and run a worker."
      );
    }
  }

  if (errors.length > 0) {
    // eslint-disable-next-line no-console
    console.error("[boot] Refusing to start due to configuration errors:");
    for (const e of errors) console.error("  - " + e);
    process.exit(1);
  }
};

validateBootConfig();
assertStorageIsHealthy();

// ── Start server ────────────────────────────────────────────────────────────
const server = app.listen(port, async () => {
  // eslint-disable-next-line no-console
  console.log(`Server running on port ${port}`);

  try {
    await prisma.$queryRaw`SELECT 1`;
    // eslint-disable-next-line no-console
    console.log("Database connected");
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("Database connection failed", error);
  }

  // Reconcile any audits left in PROCESSING from a previous run.
  // Best-effort: a failure here doesn't block startup.
  try {
    const { reconciled } = await reconcileStuckAuditsOnce();
    if (reconciled > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[boot] Reconciled ${reconciled} audit(s) stuck in PROCESSING from previous run.`
      );
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("[boot] Stuck-audit reconciliation failed", error);
  }
});

// Configure socket timeouts so slow clients can't hold connections forever.
server.keepAliveTimeout = Number(process.env.HTTP_KEEPALIVE_MS || 65_000);
server.headersTimeout = Number(process.env.HTTP_HEADERS_MS || 66_000);

// ── Graceful shutdown ───────────────────────────────────────────────────────
let isShuttingDown = false;
const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS || 30_000);

const shutdown = async (signal) => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  // eslint-disable-next-line no-console
  console.log(`[server] Received ${signal}. Draining HTTP connections...`);

  // Stop accepting new connections; finish in-flight requests.
  server.close(async (closeErr) => {
    if (closeErr) {
      // eslint-disable-next-line no-console
      console.error("[server] server.close error", closeErr);
    }
    try {
      await prisma.$disconnect();
    } catch (prismaErr) {
      // eslint-disable-next-line no-console
      console.error("[server] prisma.$disconnect error", prismaErr);
    }
    // eslint-disable-next-line no-console
    console.log("[server] Shutdown complete.");
    process.exit(closeErr ? 1 : 0);
  });

  // Hard-exit guard in case server.close() hangs on a stuck connection.
  setTimeout(() => {
    // eslint-disable-next-line no-console
    console.error(
      `[server] Forced exit after ${SHUTDOWN_TIMEOUT_MS}ms — connections did not drain.`
    );
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
