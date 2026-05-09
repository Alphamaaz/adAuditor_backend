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
import {
  adminPlanRoutes,
  meRoutes as planMeRoutes,
  publicPlanRoutes,
} from "./modules/plans/plan.routes.js";
import { initializeAuditQueueProcessors } from "./queues/auditQueue.js";

// Wire up job processors. In inline mode this registers in-process handlers;
// in Bull mode the worker process attaches its own — but the API still needs
// the registry populated so enqueue() can find them when running inline.
initializeAuditQueueProcessors();

const app = express();
const clientOrigin = process.env.APP_URL || process.env.CLIENT_ORIGIN || "http://localhost:3000";

app.use(logger);
app.use(
  cors({
    origin: clientOrigin,
    credentials: true,
  })
);
app.use(express.json());
app.use(cookieParser);

app.get("/", (req, res) => {
  res.json({
    name: "AdAuditor API",
    status: "running",
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
  });
});

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
app.use("/api/plans", publicPlanRoutes);
app.use("/api/billing", planMeRoutes);
app.use("/api/admin/plans", adminPlanRoutes);

app.use(notFoundHandler);
app.use(globalErrorHandler);

export default app;
