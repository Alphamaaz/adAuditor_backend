import { prisma } from "../../lib/prisma.js";
import { DEFAULT_SUBSCRIPTION_PLANS } from "./plan.defaults.js";

export const seedDefaultSubscriptionPlans = async () => {
  const plans = [];

  for (const plan of DEFAULT_SUBSCRIPTION_PLANS) {
    const savedPlan = await prisma.subscriptionPlan.upsert({
      where: { slug: plan.slug },
      create: plan,
      update: {
        name: plan.name,
        description: plan.description,
        priceCents: plan.priceCents,
        currency: plan.currency,
        monthlyAuditLimit: plan.monthlyAuditLimit,
        platformLimit: plan.platformLimit,
        historyDays: plan.historyDays,
        features: plan.features,
        isActive: plan.isActive,
      },
    });

    plans.push(savedPlan);
  }

  return plans;
};
