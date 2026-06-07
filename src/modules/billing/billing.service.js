/**
 * Billing service — Stripe integration.
 *
 * Responsibilities:
 *   - Lazy Stripe client init (env-gated; module is import-safe without keys)
 *   - Checkout Session creation
 *   - Customer portal redirect
 *   - Subscription state machine from webhook events
 *
 * The webhook handler (billing.webhooks.js) is the SOURCE OF TRUTH for
 * Subscription rows. Controllers never write Subscription state directly.
 */

import Stripe from "stripe";
import { prisma } from "../../lib/prisma.js";
import { badRequest, serviceUnavailable } from "../../utils/appError.js";

let stripeClient = null;

export const getStripeClient = () => {
  if (stripeClient) return stripeClient;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw serviceUnavailable(
      "Stripe is not configured. Set STRIPE_SECRET_KEY in the environment."
    );
  }
  stripeClient = new Stripe(key, {
    apiVersion: "2024-06-20",
    typescript: false,
  });
  return stripeClient;
};

const STRIPE_STATUS_MAP = {
  trialing: "TRIALING",
  active: "ACTIVE",
  past_due: "PAST_DUE",
  canceled: "CANCELED",
  unpaid: "UNPAID",
  paused: "PAUSED",
  incomplete: "TRIALING",
  incomplete_expired: "CANCELED",
};

export const mapStripeStatus = (stripeStatus) =>
  STRIPE_STATUS_MAP[stripeStatus] ?? "TRIALING";

/**
 * Read current period start/end from a Stripe subscription object,
 * tolerating both pre-2025-03-31 (top-level) and post (items.data[0]) shapes.
 * Returns { start, end } as Unix seconds or null.
 */
export const extractCurrentPeriod = (stripeSub) => {
  if (!stripeSub) return { start: null, end: null };
  // Pre-2025-03-31 API: top-level
  const topStart = stripeSub.current_period_start;
  const topEnd = stripeSub.current_period_end;
  if (topStart && topEnd) return { start: topStart, end: topEnd };
  // 2025-03-31+ API: per-item. Take the first item (single-price model).
  const item = stripeSub.items?.data?.[0];
  if (item?.current_period_start && item?.current_period_end) {
    return { start: item.current_period_start, end: item.current_period_end };
  }
  return { start: null, end: null };
};

/**
 * Create a Checkout Session for upgrading or new-paid signup.
 * Returns { url } where the frontend redirects the user.
 */
export const createCheckoutSession = async ({
  organizationId,
  planId,
  successUrl,
  cancelUrl,
  customerEmail,
}) => {
  const stripe = getStripeClient();
  const plan = await prisma.subscriptionPlan.findUnique({ where: { id: planId } });
  if (!plan) throw badRequest("Plan not found");
  if (!plan.stripePriceId) {
    throw badRequest(
      `Plan "${plan.slug}" has no stripePriceId configured. Cannot start checkout.`
    );
  }

  const existing = await prisma.subscription.findUnique({
    where: { organizationId },
  });

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: plan.stripePriceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    customer: existing?.stripeCustomerId || undefined,
    customer_email: existing?.stripeCustomerId ? undefined : customerEmail,
    client_reference_id: organizationId,
    allow_promotion_codes: true,
    subscription_data: {
      metadata: { organizationId, planId },
    },
    metadata: { organizationId, planId },
  });

  return { url: session.url, sessionId: session.id };
};

/**
 * Create a Stripe Customer Portal session for plan management / cancellation.
 */
export const createPortalSession = async ({ organizationId, returnUrl }) => {
  const stripe = getStripeClient();
  const subscription = await prisma.subscription.findUnique({
    where: { organizationId },
  });
  if (!subscription?.stripeCustomerId) {
    throw badRequest("No Stripe customer on file. Complete checkout first.");
  }
  const session = await stripe.billingPortal.sessions.create({
    customer: subscription.stripeCustomerId,
    return_url: returnUrl,
  });
  return { url: session.url };
};

/**
 * Idempotent upsert of Subscription row from a Stripe subscription object.
 * Called by webhook handlers.
 */
export const upsertSubscriptionFromStripe = async ({
  stripeSubscription,
  organizationId,
  planId,
}) => {
  const orgId =
    organizationId ||
    stripeSubscription.metadata?.organizationId ||
    null;
  if (!orgId) {
    console.warn(
      `[billing] subscription event ${stripeSubscription.id} missing organizationId metadata; skipping`
    );
    return null;
  }

  const status = mapStripeStatus(stripeSubscription.status);
  const { start, end } = extractCurrentPeriod(stripeSubscription);
  const data = {
    organizationId: orgId,
    status,
    planId: planId ?? undefined,
    stripeCustomerId: stripeSubscription.customer,
    stripeSubscriptionId: stripeSubscription.id,
    currentPeriodStart: start ? new Date(start * 1000) : null,
    currentPeriodEnd: end ? new Date(end * 1000) : null,
    cancelAtPeriodEnd: Boolean(stripeSubscription.cancel_at_period_end),
  };

  return prisma.subscription.upsert({
    where: { organizationId: orgId },
    create: data,
    update: data,
  });
};

/**
 * Resolve the Plan record from a Stripe subscription's price.
 */
export const findPlanByStripePrice = async (priceId) => {
  if (!priceId) return null;
  return prisma.subscriptionPlan.findFirst({
    where: { stripePriceId: priceId },
  });
};
