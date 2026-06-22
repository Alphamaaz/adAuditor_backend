import multer from "multer";
import { prisma } from "../../lib/prisma.js";
import { getOrganizationId } from "../../utils/requestContext.js";
import { badRequest, notFound } from "../../utils/appError.js";

const ALLOWED_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/svg+xml"]);
const MAX_LOGO_BYTES = 500 * 1024; // 500 KB
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export const uploadLogoMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_LOGO_BYTES },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      return cb(badRequest("Logo must be PNG, JPEG, WebP, or SVG."));
    }
    cb(null, true);
  },
}).single("logo");

const getOrg = (organizationId) =>
  prisma.organization.findUnique({
    where: { id: organizationId },
    select: { brandingSettings: true },
  });

/**
 * GET /api/organizations/branding
 */
export const getBranding = async (req, res) => {
  const organizationId = getOrganizationId(req);
  const org = await getOrg(organizationId);
  if (!org) throw notFound("Organization not found.");
  res.json({ status: "success", data: org.brandingSettings || {} });
};

/**
 * PUT /api/organizations/branding
 * Body: { companyName?, tagline?, preparedBy?, website?, primaryColor? }
 * All fields are optional patch-style — omitting a field leaves it unchanged.
 * Send null to clear a field.
 */
export const updateBranding = async (req, res) => {
  const organizationId = getOrganizationId(req);
  const { companyName, tagline, preparedBy, website, primaryColor } = req.body;

  if (primaryColor !== undefined && primaryColor !== null && !HEX_COLOR_RE.test(primaryColor)) {
    throw badRequest("primaryColor must be a 6-digit hex color (e.g. #1B5742).");
  }

  const org = await getOrg(organizationId);
  if (!org) throw notFound("Organization not found.");

  const current = org.brandingSettings || {};
  const patch = {};
  if (companyName !== undefined) patch.companyName = companyName;
  if (tagline !== undefined) patch.tagline = tagline;
  if (preparedBy !== undefined) patch.preparedBy = preparedBy;
  if (website !== undefined) patch.website = website;
  if (primaryColor !== undefined) patch.primaryColor = primaryColor;

  const updated = { ...current, ...patch };

  await prisma.organization.update({
    where: { id: organizationId },
    data: { brandingSettings: updated },
  });

  res.json({ status: "success", data: updated });
};

/**
 * POST /api/organizations/branding/logo
 * multipart/form-data with field "logo"
 */
export const uploadLogo = async (req, res) => {
  const organizationId = getOrganizationId(req);

  if (!req.file) throw badRequest("Logo file is required.");

  const logoBase64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}`;

  const org = await getOrg(organizationId);
  if (!org) throw notFound("Organization not found.");

  const updated = { ...(org.brandingSettings || {}), logoBase64 };

  await prisma.organization.update({
    where: { id: organizationId },
    data: { brandingSettings: updated },
  });

  res.json({ status: "success", data: { logoBase64 } });
};

/**
 * DELETE /api/organizations/branding/logo
 */
export const deleteLogo = async (req, res) => {
  const organizationId = getOrganizationId(req);

  const org = await getOrg(organizationId);
  if (!org) throw notFound("Organization not found.");

  // eslint-disable-next-line no-unused-vars
  const { logoBase64: _removed, ...rest } = org.brandingSettings || {};

  await prisma.organization.update({
    where: { id: organizationId },
    data: { brandingSettings: rest },
  });

  res.json({ status: "success", data: rest });
};

// ── Agency alert routing: account assignment + per-user mute ──────────────────

/**
 * GET /api/organizations/accounts
 * Ad accounts in the org, with their current alert assignee — for the routing UI.
 */
export const listAccounts = async (req, res) => {
  const organizationId = getOrganizationId(req);
  const accounts = await prisma.adAccount.findMany({
    where: { organizationId },
    select: {
      id: true,
      name: true,
      platform: true,
      assignedUserId: true,
      monitoringEnabled: true,
      lastAutoAuditAt: true,
      assignedUser: { select: { id: true, name: true, email: true } },
    },
    orderBy: { name: "asc" },
  });
  res.json({ status: "success", data: accounts });
};

/**
 * PATCH /api/organizations/accounts/:adAccountId/monitoring
 * Body: { monitoringEnabled: boolean } — opt an account into automatic weekly
 * re-audits (only effective when the server-side AUTO_REAUDIT_ENABLED flag is on).
 */
export const updateAccountMonitoring = async (req, res) => {
  const organizationId = getOrganizationId(req);
  const { adAccountId } = req.params;
  const { monitoringEnabled } = req.body || {};
  if (typeof monitoringEnabled !== "boolean") {
    throw badRequest("monitoringEnabled must be a boolean.");
  }

  const account = await prisma.adAccount.findFirst({
    where: { id: adAccountId, organizationId },
    select: { id: true },
  });
  if (!account) throw notFound("Ad account not found.");

  const updated = await prisma.adAccount.update({
    where: { id: adAccountId },
    data: { monitoringEnabled },
    select: { id: true, name: true, monitoringEnabled: true },
  });
  res.json({ status: "success", data: updated });
};

/**
 * GET /api/organizations/members
 * Org members with role + alert mute state — for the routing/preferences UI.
 */
export const listMembers = async (req, res) => {
  const organizationId = getOrganizationId(req);
  const members = await prisma.organizationMember.findMany({
    where: { organizationId },
    select: {
      userId: true,
      role: true,
      alertsEnabled: true,
      user: { select: { id: true, name: true, email: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  res.json({ status: "success", data: members });
};

/**
 * PATCH /api/organizations/accounts/:adAccountId/assignee
 * Body: { assignedUserId: string | null }  — route this account's alerts to a
 * specific member, or null to fall back to the org owners.
 */
export const assignAccount = async (req, res) => {
  const organizationId = getOrganizationId(req);
  const { adAccountId } = req.params;
  const { assignedUserId } = req.body || {};

  const account = await prisma.adAccount.findFirst({
    where: { id: adAccountId, organizationId },
    select: { id: true },
  });
  if (!account) throw notFound("Ad account not found.");

  if (assignedUserId != null) {
    const member = await prisma.organizationMember.findFirst({
      where: { organizationId, userId: assignedUserId },
      select: { id: true },
    });
    if (!member) throw badRequest("Assignee must be a member of this organization.");
  }

  const updated = await prisma.adAccount.update({
    where: { id: adAccountId },
    data: { assignedUserId: assignedUserId ?? null },
    select: { id: true, name: true, assignedUserId: true },
  });
  res.json({ status: "success", data: updated });
};

/**
 * PATCH /api/organizations/alert-preferences
 * Body: { alertsEnabled: boolean }  — the current user mutes / unmutes their own
 * alert emails for this organization.
 */
export const updateAlertPreferences = async (req, res) => {
  const organizationId = getOrganizationId(req);
  const userId = req.user?.id;
  if (!userId) throw badRequest("No authenticated user.");

  const { alertsEnabled } = req.body || {};
  if (typeof alertsEnabled !== "boolean") {
    throw badRequest("alertsEnabled must be a boolean.");
  }

  const membership = await prisma.organizationMember.findFirst({
    where: { organizationId, userId },
    select: { id: true },
  });
  if (!membership) throw notFound("Membership not found.");

  await prisma.organizationMember.update({
    where: { id: membership.id },
    data: { alertsEnabled },
  });
  res.json({ status: "success", data: { alertsEnabled } });
};
