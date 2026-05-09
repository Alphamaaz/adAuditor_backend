import { paymentRequired, badRequest } from "../utils/appError.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { getOrganizationId } from "../utils/requestContext.js";
import {
  FREE_PLAN_FALLBACK,
  getOrCreateCurrentUsageCounter,
  resolveEffectivePlan,
} from "../modules/plans/plan.resolver.js";

/**
 * Attaches { plan, planSource, subscription, usageCounter } to req for the
 * resolved org. Other middleware/controllers can read this without re-querying.
 */
export const attachEffectivePlan = asyncHandler(async (req, _res, next) => {
  const organizationId = getOrganizationId(req);

  if (!organizationId) {
    return next();
  }

  const { plan, source, subscription } = await resolveEffectivePlan(
    organizationId
  );
  const usageCounter = await getOrCreateCurrentUsageCounter(
    organizationId,
    subscription
  );

  req.effectivePlan = plan;
  req.planSource = source;
  req.subscription = subscription;
  req.usageCounter = usageCounter;

  next();
});

/**
 * Enforces platformLimit at audit setup time (before audit row is created).
 * Reads from req.body.selectedPlatforms.
 */
export const enforcePlatformLimit = asyncHandler(async (req, _res, next) => {
  const requested = Array.isArray(req.body?.selectedPlatforms)
    ? [...new Set(req.body.selectedPlatforms)]
    : [];

  const limit =
    req.effectivePlan?.platformLimit ?? FREE_PLAN_FALLBACK.platformLimit;

  if (limit != null && requested.length > limit) {
    throw paymentRequired(
      `Your plan allows up to ${limit} platform${limit === 1 ? "" : "s"} per audit. Upgrade to add more.`,
      {
        limit,
        requested: requested.length,
        platforms: requested,
        plan: req.effectivePlan?.slug || "free",
      }
    );
  }

  next();
});

/**
 * Enforces monthlyAuditLimit before triggering an audit run.
 * null limit = unlimited (Agency tier).
 */
export const enforceMonthlyAuditLimit = asyncHandler(
  async (req, _res, next) => {
    const limit =
      req.effectivePlan?.monthlyAuditLimit ??
      FREE_PLAN_FALLBACK.monthlyAuditLimit;

    if (limit == null) {
      return next(); // unlimited
    }

    const used = req.usageCounter?.auditsRun ?? 0;

    if (used >= limit) {
      throw paymentRequired(
        `You have used ${used} of ${limit} audit runs this billing period. Upgrade to run more audits.`,
        {
          limit,
          used,
          plan: req.effectivePlan?.slug || "free",
          periodStart: req.usageCounter?.periodStart,
          periodEnd: req.usageCounter?.periodEnd,
        }
      );
    }

    next();
  }
);

/**
 * Combined enforcement at audit setup: requires plan attached + platform check.
 */
export const enforceAuditSetupLimits = [
  attachEffectivePlan,
  enforcePlatformLimit,
];

/**
 * Combined enforcement at audit run: requires plan + counter check.
 */
export const enforceAuditRunLimits = [
  attachEffectivePlan,
  enforceMonthlyAuditLimit,
];

/**
 * Optional check: ensure the requested data source is allowed by the plan.
 * Manual upload is always allowed; OAuth requires features.oauthConnections.
 */
export const enforceDataSourceAllowed = asyncHandler(
  async (req, _res, next) => {
    const dataSource = req.body?.dataSource;

    if (!dataSource) {
      return next();
    }

    if (dataSource === "MANUAL_UPLOAD") {
      return next();
    }

    if (dataSource === "OAUTH" || dataSource === "API") {
      const features = req.effectivePlan?.features || {};
      if (!features.oauthConnections) {
        throw paymentRequired(
          "OAuth/API connections are not available on your current plan. Use manual CSV upload, or upgrade to Pro/Agency.",
          {
            dataSource,
            plan: req.effectivePlan?.slug || "free",
          }
        );
      }
    }

    next();
  }
);
