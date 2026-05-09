import { badRequest } from "./appError.js";

export const getPrimaryMembership = (req) => {
  const membership = req.user?.memberships?.[0];

  if (!membership?.organizationId) {
    throw badRequest("No organization found for this account.");
  }

  return membership;
};

export const getOrganizationId = (req) => getPrimaryMembership(req).organizationId;
