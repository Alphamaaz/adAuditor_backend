import { badRequest, unauthorized } from "../../utils/appError.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import {
  createCheckoutSession,
  createPortalSession,
} from "./billing.service.js";

const resolveOrganizationId = (req) => {
  const membership = req.user?.memberships?.[0];
  if (!membership) throw badRequest("User has no organization membership");
  return membership.organizationId;
};

export const postCreateCheckout = asyncHandler(async (req, res) => {
  if (!req.user) throw unauthorized();
  const organizationId = resolveOrganizationId(req);
  const { url, sessionId } = await createCheckoutSession({
    organizationId,
    planId: req.body.planId,
    successUrl: req.body.successUrl,
    cancelUrl: req.body.cancelUrl,
    customerEmail: req.user.email,
  });
  res.json({ url, sessionId });
});

export const postCreatePortal = asyncHandler(async (req, res) => {
  if (!req.user) throw unauthorized();
  const organizationId = resolveOrganizationId(req);
  const { url } = await createPortalSession({
    organizationId,
    returnUrl: req.body.returnUrl,
  });
  res.json({ url });
});
