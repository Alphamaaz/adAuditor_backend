import { prisma } from "../../lib/prisma.js";

/**
 * Resolves the effective subscription plan for an organization.
 *
 * Priority order (PRD §billing):
 *   1. Active PlanOverride (admin-granted, may have expiresAt)
 *   2. Active Subscription (status in ACTIVE/TRIALING)
 *   3. Free fallback — null plan, treat as Starter-level minimum
 *
 * Returns: { plan, source, override, subscription }
 *   - plan: SubscriptionPlan record or null
 *   - source: "override" | "subscription" | "free"
 */
export const resolveEffectivePlan = async (organizationId) => {
  if (!organizationId) {
    return { plan: null, source: "free", override: null, subscription: null };
  }

  const [override, subscription] = await Promise.all([
    prisma.planOverride.findUnique({
      where: { organizationId },
      include: { plan: true },
    }),
    prisma.subscription.findUnique({
      where: { organizationId },
      include: { plan: true },
    }),
  ]);

  const now = new Date();
  const overrideActive =
    override?.plan &&
    (!override.expiresAt || override.expiresAt > now);

  if (overrideActive) {
    return {
      plan: override.plan,
      source: "override",
      override,
      subscription,
    };
  }

  const subscriptionActive =
    subscription?.plan &&
    ["ACTIVE", "TRIALING"].includes(subscription.status);

  if (subscriptionActive) {
    return {
      plan: subscription.plan,
      source: "subscription",
      override,
      subscription,
    };
  }

  return {
    plan: null,
    source: "free",
    override,
    subscription,
  };
};

/**
 * Returns the [start, end) of the current usage period for the org.
 * If a Subscription has currentPeriodStart/End, use that. Otherwise,
 * fall back to a calendar month so the free tier still works.
 */
export const resolveCurrentUsagePeriod = (subscription) => {
  if (
    subscription?.currentPeriodStart &&
    subscription?.currentPeriodEnd &&
    subscription.currentPeriodEnd > new Date()
  ) {
    return {
      periodStart: subscription.currentPeriodStart,
      periodEnd: subscription.currentPeriodEnd,
      source: "subscription",
    };
  }

  const now = new Date();
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const periodEnd = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)
  );

  return { periodStart, periodEnd, source: "calendar" };
};

/**
 * Reads (or creates) the UsageCounter for the current period and returns it.
 * Does NOT increment — call recordAuditRun after a successful run instead.
 */
export const getOrCreateCurrentUsageCounter = async (
  organizationId,
  subscription
) => {
  const { periodStart, periodEnd } = resolveCurrentUsagePeriod(subscription);

  const counter = await prisma.usageCounter.upsert({
    where: {
      organizationId_periodStart_periodEnd: {
        organizationId,
        periodStart,
        periodEnd,
      },
    },
    create: {
      organizationId,
      periodStart,
      periodEnd,
      auditsRun: 0,
    },
    update: {},
  });

  return counter;
};

/**
 * Increments auditsRun by 1 for the current period. Idempotency-friendly:
 * uses an atomic update so concurrent runs don't lose counts.
 */
export const recordAuditRun = async (organizationId, subscription) => {
  const { periodStart, periodEnd } = resolveCurrentUsagePeriod(subscription);

  return prisma.usageCounter.upsert({
    where: {
      organizationId_periodStart_periodEnd: {
        organizationId,
        periodStart,
        periodEnd,
      },
    },
    create: {
      organizationId,
      periodStart,
      periodEnd,
      auditsRun: 1,
    },
    update: {
      auditsRun: { increment: 1 },
    },
  });
};

/**
 * Free-tier defaults (used when no plan or override is active).
 * Generous enough to demo, restrictive enough to push upgrade.
 *
 * Free does NOT include AI narrative — the deterministic report is the
 * preview. Upgrading to Starter unlocks manual AI; Pro unlocks auto-AI.
 */
export const FREE_PLAN_FALLBACK = {
  monthlyAuditLimit: 1,
  platformLimit: 1,
  features: {
    pdfExport: true,
    manualUpload: true,
    oauthConnections: false,
    aiNarrative: false,
  },
};

/**
 * Returns the AI narrative mode for a plan (or the free fallback). One of:
 *   - "automatic": auto-chain the AI job after each deterministic run
 *   - "manual":    user must explicitly click Generate AI report
 *   - false:       AI is not available on this plan; show upgrade CTA
 *
 * Plans loaded from the DB store features as JSON; we read defensively so a
 * legacy plan row without the field falls back to "manual" (safest middle
 * ground — UI shows the button, but doesn't auto-burn tokens).
 */
export const getAiNarrativeMode = (plan) => {
  if (!plan) return FREE_PLAN_FALLBACK.features.aiNarrative;
  const value = plan.features?.aiNarrative;
  if (value === "automatic" || value === "manual" || value === false) {
    return value;
  }
  // Legacy plan row missing the field — default to manual so paid users
  // still get the AI button, even if the seed hasn't been re-run.
  return "manual";
};
