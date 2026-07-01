import { prisma } from "../../lib/prisma.js";
import { badRequest, notFound } from "../../utils/appError.js";
import {
  serializeAdminUser,
  serializeAdminOrganization,
  serializeAdminStats,
} from "./admin.presenter.js";
import { createSessionToken, hashSessionToken } from "../../utils/sessionToken.js";
import { purgeUserAndOwnedData } from "../auth/accountDeletion.service.js";
import { 
  SESSION_COOKIE_NAME, 
  ADMIN_IMPERSONATION_COOKIE_NAME,
  SESSION_TTL_DAYS,
  getSessionCookieOptions 
} from "../../config/auth.js";

const getSessionExpiresAt = () =>
  new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

export const getStats = async (req, res) => {
  const [
    userCount,
    activeUserCount,
    orgCount,
    auditCount,
    recentAuditCount,
    platformStatsRaw,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { status: "ACTIVE" } }),
    prisma.organization.count(),
    prisma.audit.count(),
    prisma.audit.count({
      where: { createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } },
    }),
    prisma.audit.groupBy({
      by: ["selectedPlatforms"],
      _count: true,
    }),
  ]);

  // selectedPlatforms is an array, groupBy treats the whole array as a key.
  // We need to flatten it for true platform stats.
  const platformStats = { META: 0, GOOGLE: 0, TIKTOK: 0 };
  platformStatsRaw.forEach((group) => {
    group.selectedPlatforms.forEach((p) => {
      if (platformStats[p] !== undefined) platformStats[p] += group._count;
    });
  });

  res.json({
    status: "success",
    data: serializeAdminStats({
      userCount,
      activeUserCount,
      orgCount,
      auditCount,
      recentAuditCount,
      platformStats,
    }),
  });
};

export const listUsers = async (req, res) => {
  const { page, limit, search, status, role } = req.query;
  const skip = (page - 1) * limit;

  const where = {};
  const and = [];

  if (search && search.trim() !== "") {
    and.push({
      OR: [
        { email: { contains: search, mode: "insensitive" } },
        { name: { contains: search, mode: "insensitive" } },
      ],
    });
  }

  if (status) and.push({ status });
  if (role) and.push({ internalRole: role });

  if (and.length > 0) {
    where.AND = and;
  }

  console.log("[AdminController] listUsers where:", JSON.stringify(where, null, 2));

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      include: {
        memberships: {
          include: { organization: true },
        },
      },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.user.count({ where }),
  ]);

  res.json({
    status: "success",
    data: users.map(serializeAdminUser),
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  });
};

export const updateUserStatus = async (req, res) => {
  const { userId } = req.params;
  const { status } = req.body;

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw notFound("User not found");

  if (user.internalRole === "SUPER_ADMIN") {
    throw badRequest("Cannot change status of a Super Admin");
  }

  const updatedUser = await prisma.user.update({
    where: { id: userId },
    data: { status },
    include: {
      memberships: {
        include: { organization: true },
      },
    },
  });

  res.json({
    status: "success",
    data: serializeAdminUser(updatedUser),
  });
};

export const deleteUser = async (req, res) => {
  const { userId } = req.params;

  if (userId === req.user.id) {
    throw badRequest("You cannot delete your own admin account");
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw notFound("User not found");

  if (user.internalRole === "SUPER_ADMIN") {
    throw badRequest("Cannot delete a Super Admin");
  }

  const updatedUser = await prisma.$transaction(async (tx) => {
    await tx.authSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    return tx.user.update({
      where: { id: userId },
      data: { status: "DELETED" },
      include: {
        memberships: {
          include: { organization: true },
        },
      },
    });
  });

  res.json({
    status: "success",
    message: "User account soft-deleted. Existing sessions have been revoked.",
    data: serializeAdminUser(updatedUser),
  });
};

/**
 * HARD delete — permanently purges a user and all data they own, to honor a
 * data-deletion request. Irreversible. Distinct from deleteUser (soft-delete).
 */
export const purgeUser = async (req, res) => {
  const { userId } = req.params;

  if (userId === req.user.id) {
    throw badRequest("You cannot delete your own admin account");
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw notFound("User not found");

  if (user.internalRole === "SUPER_ADMIN") {
    throw badRequest("Cannot delete a Super Admin");
  }

  const result = await purgeUserAndOwnedData(userId);

  res.json({
    status: "success",
    message:
      `User and all owned data permanently deleted ` +
      `(${result.deletedOrganizations} organization(s), ${result.deletedConnections} platform connection(s) removed).`,
    data: { userId, ...result },
  });
};

export const listOrganizations = async (req, res) => {
  const { page, limit, search } = req.query;
  const skip = (page - 1) * limit;

  const where = {};
  if (search && search.trim() !== "") {
    where.name = { contains: search, mode: "insensitive" };
  }

  console.log("[AdminController] listOrganizations where:", JSON.stringify(where, null, 2));

  const [orgs, total] = await Promise.all([
    prisma.organization.findMany({
      where,
      include: {
        owner: true,
        subscription: {
          include: { plan: true },
        },
        planOverride: {
          include: { plan: true },
        },
        _count: {
          select: { members: true, audits: true },
        },
      },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.organization.count({ where }),
  ]);

  res.json({
    status: "success",
    data: orgs.map(serializeAdminOrganization),
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  });
};

export const impersonateUser = async (req, res) => {
  const { userId, reason = "Manual impersonation" } = req.body;
  const adminId = req.user.id;
  
  // Get the current admin session token from cookies to save it for later
  const originalToken = req.cookies[SESSION_COOKIE_NAME];

  const targetUser = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      memberships: {
        include: { organization: true },
      },
    },
  });

  if (!targetUser) throw notFound("User not found");
  if (targetUser.internalRole === "SUPER_ADMIN") {
    throw badRequest("Cannot impersonate another Super Admin");
  }

  const token = createSessionToken();
  
  await prisma.$transaction(async (tx) => {
    // Log the impersonation session
    await tx.impersonationSession.create({
      data: {
        adminUserId: adminId,
        targetUserId: userId,
        reason,
        ipAddress: req.ip,
        userAgent: req.get("user-agent"),
      },
    });

    // Create a real session for the target user
    await tx.authSession.create({
      data: {
        userId,
        tokenHash: hashSessionToken(token),
        userAgent: `Impersonated by ${req.user.email}: ${req.get("user-agent")}`,
        ipAddress: req.ip,
        expiresAt: getSessionExpiresAt(),
      },
    });
  });

  // Store the admin's original token so they can return later
  res.cookie(ADMIN_IMPERSONATION_COOKIE_NAME, originalToken, getSessionCookieOptions());
  
  // Set the main session cookie to the impersonated user's token
  res.cookie(SESSION_COOKIE_NAME, token, getSessionCookieOptions());

  res.json({
    status: "success",
    message: `Now impersonating ${targetUser.email}`,
    data: {
      user: {
        id: targetUser.id,
        email: targetUser.email,
        name: targetUser.name,
      },
    },
  });
};

/**
 * POST /api/admin/stop-impersonation
 * Swaps back the session token from the saved admin token.
 */
export const stopImpersonation = async (req, res) => {
  const originalAdminToken = req.cookies[ADMIN_IMPERSONATION_COOKIE_NAME];

  if (!originalAdminToken) {
    throw badRequest("No active impersonation session found to return to.");
  }

  // Restore the admin token to the main session cookie
  res.cookie(SESSION_COOKIE_NAME, originalAdminToken, getSessionCookieOptions());
  
  // Clear the impersonation marker
  res.clearCookie(ADMIN_IMPERSONATION_COOKIE_NAME, getSessionCookieOptions());

  res.json({
    status: "success",
    message: "Impersonation stopped. Session restored to administrator.",
  });
};


/**
 * PATCH /api/admin/organizations/:organizationId/plan
 * Manually overrides the plan for an organization.
 */
export const updateOrganizationPlan = async (req, res) => {
  const { organizationId } = req.params;
  const { planId, reason } = req.body;

  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    include: { subscription: true },
  });

  if (!organization) throw notFound("Organization not found");

  if (!planId) {
    // Revoke override
    await prisma.planOverride.deleteMany({
      where: { organizationId },
    });

    return res.json({
      status: "success",
      message: "Plan override removed. Organization will revert to their base subscription.",
    });
  }

  const plan = await prisma.subscriptionPlan.findUnique({
    where: { id: planId },
  });

  if (!plan) throw notFound("Plan not found");

  const planOverride = await prisma.planOverride.upsert({
    where: { organizationId },
    update: {
      planId,
      reason,
      expiresAt: null, // Admin overrides are permanent until changed
    },
    create: {
      organizationId,
      planId,
      reason,
      expiresAt: null,
    },
  });

  res.json({
    status: "success",
    message: `Organization plan overridden to ${plan.name}`,
    data: planOverride,
  });
};
