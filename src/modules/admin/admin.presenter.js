export const serializeAdminUser = (user) => ({
  id: user.id,
  email: user.email,
  name: user.name,
  status: user.status,
  internalRole: user.internalRole,
  emailVerifiedAt: user.emailVerifiedAt,
  lastLoginAt: user.lastLoginAt,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
  organizations: (user.memberships || []).map((m) => ({
    id: m.organization?.id,
    name: m.organization?.name || "Unknown",
    role: m.role,
  })),
});

export const serializeAdminOrganization = (org) => ({
  id: org.id,
  name: org.name,
  ownerId: org.ownerId,
  owner: org.owner ? {
    id: org.owner.id,
    email: org.owner.email,
    name: org.owner.name,
  } : null,
  memberCount: org._count?.members,
  auditCount: org._count?.audits,
  subscription: (org.planOverride?.plan || org.subscription) ? {
    status: org.planOverride ? "ACTIVE" : (org.subscription?.status || "ACTIVE"),
    planName: org.planOverride?.plan?.name || org.subscription?.plan?.name,
    planSlug: org.planOverride?.plan?.slug || org.subscription?.plan?.slug,
    currentPeriodEnd: org.subscription?.currentPeriodEnd,
    isOverridden: !!org.planOverride,
    overrideReason: org.planOverride?.reason,
  } : null,
  createdAt: org.createdAt,
  updatedAt: org.updatedAt,
});

export const serializeAdminStats = (stats) => ({
  totalUsers: stats.userCount,
  activeUsers: stats.activeUserCount,
  totalOrganizations: stats.orgCount,
  totalAudits: stats.auditCount,
  auditsLast30Days: stats.recentAuditCount,
  platformStats: stats.platformStats,
});
