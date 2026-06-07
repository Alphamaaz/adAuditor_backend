/**
 * Stripe webhook handler.
 *
 * MOUNTED with express.raw() BEFORE express.json() — see app.js.
 * Signature is verified with the raw body bytes; parsed JSON would break it.
 *
 * Idempotency: every event is recorded in StripeEvent. If we've already
 * processed an eventId, we return 200 without re-running side effects.
 */

import { prisma } from "../../lib/prisma.js";
import {
  getStripeClient,
  upsertSubscriptionFromStripe,
  findPlanByStripePrice,
} from "./billing.service.js";

const PROCESSABLE_EVENTS = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.trial_will_end",
  "invoice.payment_failed",
  "invoice.payment_succeeded",
  "invoice.upcoming",
  "payment_method.detached",
]);

const recordEvent = async ({ event, processedAt = null }) =>
  prisma.stripeEvent.upsert({
    where: { eventId: event.id },
    create: {
      eventId: event.id,
      type: event.type,
      payload: event,
      processedAt,
    },
    update: { processedAt },
  });

export const handleStripeWebhook = async (req, res) => {
  const signature = req.headers["stripe-signature"];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!secret) {
    console.error("[billing.webhook] STRIPE_WEBHOOK_SECRET is not configured");
    return res.status(500).json({ error: "webhook_not_configured" });
  }

  let event;
  try {
    event = getStripeClient().webhooks.constructEvent(req.body, signature, secret);
  } catch (err) {
    console.error("[billing.webhook] signature verification failed:", err.message);
    return res.status(400).json({ error: "signature_verification_failed" });
  }

  // Idempotency check
  const existing = await prisma.stripeEvent.findUnique({
    where: { eventId: event.id },
  });
  if (existing?.processedAt) {
    return res.status(200).json({ received: true, idempotent: true });
  }
  // Always record raw payload first (covers retry case).
  await recordEvent({ event });

  if (!PROCESSABLE_EVENTS.has(event.type)) {
    await recordEvent({ event, processedAt: new Date() });
    return res.status(200).json({ received: true, ignored: true });
  }

  try {
    await dispatch(event);
    await recordEvent({ event, processedAt: new Date() });
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error(`[billing.webhook] dispatch failed for ${event.type}:`, err);
    // Don't mark processedAt — Stripe will retry.
    return res.status(500).json({ error: "dispatch_failed" });
  }
};

const dispatch = async (event) => {
  switch (event.type) {
    case "checkout.session.completed":
      return onCheckoutCompleted(event.data.object);
    case "customer.subscription.created":
    case "customer.subscription.updated":
      return onSubscriptionUpserted(event.data.object);
    case "customer.subscription.deleted":
      return onSubscriptionDeleted(event.data.object);
    case "customer.subscription.trial_will_end":
      return onTrialWillEnd(event.data.object);
    case "invoice.payment_failed":
      return onInvoicePaymentFailed(event.data.object);
    case "invoice.payment_succeeded":
      return onInvoicePaymentSucceeded(event.data.object);
    case "invoice.upcoming":
      return onInvoiceUpcoming(event.data.object);
    case "payment_method.detached":
      return onPaymentMethodDetached(event.data.object);
    default:
      return null;
  }
};

const onCheckoutCompleted = async (session) => {
  const subscriptionId = session.subscription;
  if (!subscriptionId) return;
  const orgId =
    session.client_reference_id ||
    session.metadata?.organizationId ||
    null;
  const stripe = getStripeClient();
  const stripeSub = await stripe.subscriptions.retrieve(subscriptionId);
  const priceId = stripeSub.items?.data?.[0]?.price?.id;
  const plan = await findPlanByStripePrice(priceId);
  await upsertSubscriptionFromStripe({
    stripeSubscription: stripeSub,
    organizationId: orgId,
    planId: plan?.id ?? null,
  });
};

const onSubscriptionUpserted = async (stripeSub) => {
  const priceId = stripeSub.items?.data?.[0]?.price?.id;
  const plan = await findPlanByStripePrice(priceId);
  await upsertSubscriptionFromStripe({
    stripeSubscription: stripeSub,
    planId: plan?.id ?? null,
  });
};

const onSubscriptionDeleted = async (stripeSub) => {
  const orgId = stripeSub.metadata?.organizationId;
  if (!orgId) return;
  await prisma.subscription.updateMany({
    where: { stripeSubscriptionId: stripeSub.id },
    data: {
      status: "CANCELED",
      cancelAtPeriodEnd: false,
    },
  });
};

const onInvoicePaymentFailed = async (invoice) => {
  if (!invoice.subscription) return;
  await prisma.subscription.updateMany({
    where: { stripeSubscriptionId: invoice.subscription },
    data: { status: "PAST_DUE" },
  });
};

const onTrialWillEnd = async (stripeSub) => {
  // Stripe fires this 3 days before trial end. Find org + log so the
  // future email-sender pulls from a queryable trail. Email send itself
  // is deferred to v1.1 (templates pending). For now we record so it's
  // observable.
  const orgId = stripeSub.metadata?.organizationId;
  if (!orgId) return;
  // eslint-disable-next-line no-console
  console.log(
    `[billing] trial_will_end org=${orgId} subscription=${stripeSub.id}`
  );
  // TODO v1.1: enqueue retention email
};

const onInvoiceUpcoming = async (invoice) => {
  // Stripe fires 7 days before next renewal. Useful for surfacing the next
  // invoice amount in the customer portal. Log-only for v1.0.
  if (!invoice.subscription) return;
  // eslint-disable-next-line no-console
  console.log(
    `[billing] invoice.upcoming subscription=${invoice.subscription} ` +
      `amount=${invoice.amount_due} currency=${invoice.currency}`
  );
};

const onPaymentMethodDetached = async (paymentMethod) => {
  // Customer removed their card. If they have no other PM on file, future
  // renewals will fail. We can't tell without an API call; log for ops.
  const customer = paymentMethod.customer;
  if (!customer) return;
  // eslint-disable-next-line no-console
  console.warn(
    `[billing] payment_method.detached customer=${customer} ` +
      `pmType=${paymentMethod.type}. Verify the customer still has a default PM.`
  );
};

const onInvoicePaymentSucceeded = async (invoice) => {
  if (!invoice.subscription) return;
  // Status will reflect the latest from the next subscription.updated event;
  // we just clear PAST_DUE if it was set.
  await prisma.subscription.updateMany({
    where: { stripeSubscriptionId: invoice.subscription, status: "PAST_DUE" },
    data: { status: "ACTIVE" },
  });
};
