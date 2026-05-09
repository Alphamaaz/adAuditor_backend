import { prisma } from "../../lib/prisma.js";
import { notFound } from "../../utils/appError.js";
import { getOrganizationId } from "../../utils/requestContext.js";
import { serializeSubscriptionPlan } from "./plan.presenter.js";
import { seedDefaultSubscriptionPlans } from "./plan.service.js";
import {
  FREE_PLAN_FALLBACK,
  getAiNarrativeMode,
  getOrCreateCurrentUsageCounter,
  resolveEffectivePlan,
} from "./plan.resolver.js";

const planOrder = [{ priceCents: "asc" }, { createdAt: "asc" }];

export const listPublicPlans = async (req, res) => {
  const plans = await prisma.subscriptionPlan.findMany({
    where: { isActive: true },
    orderBy: planOrder,
  });

  res.json({
    status: "success",
    data: plans.map((plan) => serializeSubscriptionPlan(plan)),
  });
};

export const listAdminPlans = async (req, res) => {
  const plans = await prisma.subscriptionPlan.findMany({
    orderBy: planOrder,
  });

  res.json({
    status: "success",
    data: plans.map((plan) =>
      serializeSubscriptionPlan(plan, { includeStripe: true })
    ),
  });
};

export const createPlan = async (req, res) => {
  const plan = await prisma.subscriptionPlan.create({
    data: req.body,
  });

  res.status(201).json({
    status: "success",
    data: serializeSubscriptionPlan(plan, { includeStripe: true }),
  });
};

export const updatePlan = async (req, res) => {
  const existingPlan = await prisma.subscriptionPlan.findUnique({
    where: { id: req.params.planId },
  });

  if (!existingPlan) {
    throw notFound("Plan not found");
  }

  const plan = await prisma.subscriptionPlan.update({
    where: { id: req.params.planId },
    data: req.body,
  });

  res.json({
    status: "success",
    data: serializeSubscriptionPlan(plan, { includeStripe: true }),
  });
};

export const seedDefaultPlans = async (req, res) => {
  const plans = await seedDefaultSubscriptionPlans();

  res.json({
    status: "success",
    data: plans.map((plan) =>
      serializeSubscriptionPlan(plan, { includeStripe: true })
    ),
  });
};

/**
 * Returns the effective plan + current-period usage for the authenticated org.
 * Frontend uses this for "X of Y audits used" badges and upgrade CTAs.
 */
export const getMyPlanAndUsage = async (req, res) => {
  const organizationId = getOrganizationId(req);

  const { plan, source, subscription } = await resolveEffectivePlan(
    organizationId
  );
  const usageCounter = await getOrCreateCurrentUsageCounter(
    organizationId,
    subscription
  );

  const monthlyAuditLimit =
    plan?.monthlyAuditLimit ?? FREE_PLAN_FALLBACK.monthlyAuditLimit;
  const platformLimit =
    plan?.platformLimit ?? FREE_PLAN_FALLBACK.platformLimit;
  const aiNarrative = getAiNarrativeMode(plan);

  res.json({
    status: "success",
    data: {
      plan: plan
        ? serializeSubscriptionPlan(plan)
        : {
            slug: "free",
            name: "Free",
            monthlyAuditLimit: FREE_PLAN_FALLBACK.monthlyAuditLimit,
            platformLimit: FREE_PLAN_FALLBACK.platformLimit,
            features: FREE_PLAN_FALLBACK.features,
          },
      source,
      subscription: subscription
        ? {
            status: subscription.status,
            currentPeriodStart: subscription.currentPeriodStart,
            currentPeriodEnd: subscription.currentPeriodEnd,
            cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
          }
        : null,
      usage: {
        periodStart: usageCounter.periodStart,
        periodEnd: usageCounter.periodEnd,
        auditsRun: usageCounter.auditsRun,
        monthlyAuditLimit,
        platformLimit,
        auditsRemaining:
          monthlyAuditLimit == null
            ? null
            : Math.max(0, monthlyAuditLimit - usageCounter.auditsRun),
      },
      // Top-level capabilities — easier for the UI to read than digging
      // into features. Kept additive so older clients still work.
      capabilities: {
        aiNarrative, // "automatic" | "manual" | false
      },
    },
  });
};
