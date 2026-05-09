const formatPrice = (priceCents, currency) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    maximumFractionDigits: priceCents % 100 === 0 ? 0 : 2,
  }).format(priceCents / 100);

export const serializeSubscriptionPlan = (plan, options = {}) => {
  const includeStripe = options.includeStripe === true;

  return {
    id: plan.id,
    name: plan.name,
    slug: plan.slug,
    description: plan.description,
    priceCents: plan.priceCents,
    priceMonthly: plan.priceCents / 100,
    currency: plan.currency,
    formattedPrice: formatPrice(plan.priceCents, plan.currency),
    monthlyAuditLimit: plan.monthlyAuditLimit,
    platformLimit: plan.platformLimit,
    historyDays: plan.historyDays,
    features: plan.features,
    isActive: plan.isActive,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    ...(includeStripe ? { stripePriceId: plan.stripePriceId } : {}),
  };
};
