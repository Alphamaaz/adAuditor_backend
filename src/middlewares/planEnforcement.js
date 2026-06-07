import { paymentRequired, badRequest, serviceUnavailable } from "../utils/appError.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { getOrganizationId } from "../utils/requestContext.js";
import {
  FREE_PLAN_FALLBACK,
  getOrCreateCurrentUsageCounter,
  resolveEffectivePlan,
  resolveCurrentUsagePeriod,
} from "../modules/plans/plan.resolver.js";
import {
  sumOrgAiCostUsd,
  sumGlobalAiCostUsd,
} from "../modules/audits/aiUsage.service.js";
import {
  sumOrgStorageBytes,
  bytesToMb,
} from "../modules/audits/storageUsage.service.js";

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
/**
 * Cost cap enforcement for AI-driven endpoints.
 *
 * Two ceilings, both must hold:
 *   1. Per-org monthly cap (plan.aiMonthlyUsdCap, falls back to free-plan default)
 *   2. Global daily cap (AI_GLOBAL_DAILY_USD_CAP env var) — defends against
 *      account-wide abuse / runaway prompts
 *
 * Run AFTER attachEffectivePlan so req.subscription is available.
 */
export const enforceAiCostCap = asyncHandler(async (req, _res, next) => {
  const organizationId = getOrganizationId(req);
  const cap =
    req.effectivePlan?.aiMonthlyUsdCap != null
      ? Number(req.effectivePlan.aiMonthlyUsdCap)
      : FREE_PLAN_FALLBACK.aiMonthlyUsdCap;

  if (cap != null && Number.isFinite(cap)) {
    const { periodStart, periodEnd } = resolveCurrentUsagePeriod(
      req.subscription
    );
    const used = await sumOrgAiCostUsd({
      organizationId,
      since: periodStart,
      until: periodEnd,
    });
    if (used >= cap) {
      throw paymentRequired(
        `Monthly AI spend cap reached for your plan ($${cap.toFixed(2)}). ` +
          `Upgrade or wait until the next billing period.`,
        {
          plan: req.effectivePlan?.slug || "free",
          capUsd: cap,
          usedUsd: Number(used.toFixed(2)),
          periodStart,
          periodEnd,
        }
      );
    }
  }

  const globalCap = Number(process.env.AI_GLOBAL_DAILY_USD_CAP || 0);
  if (globalCap > 0) {
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const globalUsed = await sumGlobalAiCostUsd({ since: todayStart });
    if (globalUsed >= globalCap) {
      throw serviceUnavailable(
        "Global AI processing capacity reached for today. " +
          "Try again tomorrow or contact support.",
        { globalCapUsd: globalCap, globalUsedUsd: Number(globalUsed.toFixed(2)) }
      );
    }
  }

  next();
});

/**
 * Storage cap enforcement. Reject uploads when the org has hit its
 * cumulative storage quota. Run BEFORE multer to avoid wasting disk on
 * a file we're going to reject.
 */
export const enforceStorageCap = asyncHandler(async (req, _res, next) => {
  const organizationId = getOrganizationId(req);
  const capMb =
    req.effectivePlan?.storageMbCap ?? FREE_PLAN_FALLBACK.storageMbCap;
  if (capMb == null) return next(); // unlimited

  const usedBytes = await sumOrgStorageBytes({ organizationId });
  const usedMb = bytesToMb(usedBytes);
  if (usedMb >= capMb) {
    throw paymentRequired(
      `Storage cap reached for your plan (${capMb} MB). ` +
        `Delete old audits or upgrade for more space.`,
      {
        plan: req.effectivePlan?.slug || "free",
        capMb,
        usedMb: Number(usedMb.toFixed(2)),
      }
    );
  }
  next();
});

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
