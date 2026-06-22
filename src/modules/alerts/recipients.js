import { prisma } from "../../lib/prisma.js";
import { selectAlertRecipients } from "./alertRouting.js";

/**
 * Resolve the email recipients for an account's alert/digest, applying the
 * assignee routing + per-user mute. Shared by the immediate-alert and the
 * weekly-digest pipelines so both route identically.
 *
 * @param {object} audit  must carry organizationId, createdById, and
 *                        adAccount.assignedUserId
 * @returns {Promise<string[]>}
 */
export const resolveAccountAlertRecipients = async (audit) => {
  const members = await prisma.organizationMember.findMany({
    where: { organizationId: audit.organizationId },
    select: { userId: true, role: true, alertsEnabled: true, user: { select: { email: true } } },
  });
  return selectAlertRecipients({
    assigneeUserId: audit.adAccount?.assignedUserId || null,
    createdById: audit.createdById || null,
    members: members.map((m) => ({
      userId: m.userId,
      role: m.role,
      alertsEnabled: m.alertsEnabled,
      email: m.user?.email,
    })),
  });
};
