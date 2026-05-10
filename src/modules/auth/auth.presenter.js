export const serializeUser = (user) => ({
  id: user.id,
  email: user.email,
  name: user.name,
  status: user.status,
  internalRole: user.internalRole,
  emailVerifiedAt: user.emailVerifiedAt,
  lastLoginAt: user.lastLoginAt,
  createdAt: user.createdAt,
});

export const serializeOrganization = (organization, role) => {
  const plan = organization.planOverride?.plan || organization.subscription?.plan;
  const status = organization.planOverride ? "ACTIVE" : (organization.subscription?.status || "ACTIVE");

  return {
    id: organization.id,
    name: organization.name,
    role,
    ownerId: organization.ownerId,
    createdAt: organization.createdAt,
    plan: plan ? {
      id: plan.id,
      name: plan.name,
      slug: plan.slug,
      status: status,
      isOverridden: !!organization.planOverride,
    } : null,
  };
};

export const serializeAuthPayload = (user, isImpersonating = false) => {
  const hasBusinessProfile =
    user.memberships?.some((m) => m.organization?.businessProfile != null) ??
    false;

  return {
    user: serializeUser(user),
    organizations:
      user.memberships?.map((m) =>
        serializeOrganization(m.organization, m.role)
      ) || [],
    hasBusinessProfile,
    isImpersonating,
  };
};

export const serializeAuthSession = (session, currentSessionId) => ({
  id: session.id,
  userAgent: session.userAgent,
  ipAddress: session.ipAddress,
  expiresAt: session.expiresAt,
  revokedAt: session.revokedAt,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
  isCurrent: session.id === currentSessionId,
});
