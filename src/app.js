import { initSentry } from "./lib/sentry.js";
initSentry();

import express from "express";
import cors from "cors";
import logger from "./middlewares/logger.js";
import { cookieParser } from "./middlewares/cookies.js";
import {
  globalErrorHandler,
  notFoundHandler,
} from "./middlewares/errorHandler.js";
import { prisma } from "./lib/prisma.js";
import { asyncHandler } from "./utils/asyncHandler.js";
import authRoutes from "./modules/auth/auth.routes.js";
import businessProfileRoutes from "./modules/businessProfile/businessProfile.routes.js";
import auditRoutes from "./modules/audits/audit.routes.js";
import adminRoutes from "./modules/admin/admin.routes.js";
import platformConnectionRoutes from "./modules/platformConnections/platformConnections.routes.js";
import organizationRoutes from "./modules/organizations/organizations.routes.js";
import {
  adminPlanRoutes,
  meRoutes as planMeRoutes,
  publicPlanRoutes,
} from "./modules/plans/plan.routes.js";
import billingRoutes from "./modules/billing/billing.routes.js";
import { handleStripeWebhook } from "./modules/billing/billing.webhooks.js";
import { initializeAuditQueueProcessors } from "./queues/auditQueue.js";
import { startStuckAuditCron } from "./jobs/stuckAuditReconciliation.js";
import { startWeeklyDigestCron } from "./jobs/digestPipeline.js";
import { startReauditCron } from "./jobs/reauditPipeline.js";

// Wire up job processors. In inline mode this registers in-process handlers;
// in Bull mode the worker process attaches its own — but the API still needs
// the registry populated so enqueue() can find them when running inline.
initializeAuditQueueProcessors();

// Periodic reconciliation of audits left in PROCESSING (e.g. inline-mode
// crash, dead worker). Runs every STUCK_AUDIT_RECONCILE_INTERVAL_MS.
startStuckAuditCron();

// Daily scan that emails the weekly "since your last audit" digest to routed
// recipients. A per-account cooldown keeps the real cadence weekly.
startWeeklyDigestCron();

// Scheduled auto re-audit of monitored accounts. No-op unless
// AUTO_REAUDIT_ENABLED — inert by default so it never auto-consumes plan quota.
startReauditCron();

const app = express();
app.set("trust proxy", 1);
const clientOrigin = process.env.APP_URL || process.env.CLIENT_ORIGIN || "http://localhost:3000";

app.use(logger);
app.use(
  cors({
    origin: clientOrigin,
    credentials: true,
  })
);

// Stripe webhook MUST receive raw body for signature verification.
// Mount BEFORE express.json() so the JSON parser doesn't consume the body.
app.post(
  "/api/billing/webhook",
  express.raw({ type: "application/json" }),
  asyncHandler(handleStripeWebhook)
);

app.use(express.json());
app.use(cookieParser);

app.get("/", (req, res) => {
  res.json({
    name: "AdAuditor API",
    status: "running",
  });
});

// Liveness — no DB hit. For container/load-balancer health checks.
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
  });
});

// Readiness — verifies DB connection + reports which optional integrations are
// configured (booleans only — never exposes secret values). Use for "is the
// app ready to serve traffic?" and as a quick config sanity check at launch.
app.get(
  "/api/ready",
  asyncHandler(async (req, res) => {
    await prisma.$queryRaw`SELECT 1`;
    const aiProvider = (process.env.AI_PROVIDER || "gemini").toLowerCase();
    const aiKeyByProvider = {
      gemini: "GEMINI_API_KEY",
      openai: "OPENAI_API_KEY",
      deepseek: "DEEPSEEK_API_KEY",
      anthropic: "ANTHROPIC_API_KEY",
    };
    res.json({
      status: "ok",
      database: "connected",
      uptime: process.uptime(),
      env: process.env.NODE_ENV || "development",
      integrations: {
        // AI: is the configured provider's key present? Deterministic report
        // is the fallback when this is false, so it's non-fatal.
        aiProvider,
        aiConfigured: Boolean(process.env[aiKeyByProvider[aiProvider]]),
        aiGlobalDailyCapUsd: Number(process.env.AI_GLOBAL_DAILY_USD_CAP || 0),
        stripe: Boolean(process.env.STRIPE_SECRET_KEY),
        stripeWebhook: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
        sentry: Boolean(process.env.SENTRY_DSN),
        smtp: Boolean(process.env.SMTP_HOST),
        redis: Boolean(process.env.REDIS_URL),
        jobQueueDriver: (process.env.JOB_QUEUE_DRIVER || "inline").toLowerCase(),
        tokenEncryption: Boolean(
          process.env.ENCRYPTION_KEY && process.env.ENCRYPTION_KEY.length === 64
        ),
        storagePersistent: process.env.STORAGE_PERSISTENT === "true",
        piiRedaction: process.env.AI_PII_REDACTION === "true",
      },
    });
  })
);

// Backward-compat alias.
app.get(
  "/api/db-check",
  asyncHandler(async (req, res) => {
    await prisma.$queryRaw`SELECT 1`;
    res.json({
      status: "ok",
      database: "connected",
    });
  })
);

app.use("/api/auth", authRoutes);
app.use("/api/business-profile", businessProfileRoutes);
app.use("/api/audits", auditRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/platform-connections", platformConnectionRoutes);
app.use("/api/organizations", organizationRoutes);
app.use("/api/plans", publicPlanRoutes);
app.use("/api/billing", planMeRoutes);
app.use("/api/billing", billingRoutes);
app.use("/api/admin/plans", adminPlanRoutes);

app.use(notFoundHandler);
app.use(globalErrorHandler);

export default app;
