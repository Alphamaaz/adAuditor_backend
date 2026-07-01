import { prisma } from "../../lib/prisma.js";

/**
 * Permanently and irreversibly deletes a user and all data they own, to honor a
 * data-deletion request (GDPR / Google API Services User Data Policy).
 *
 * This is a HARD delete, distinct from the admin soft-delete (status=DELETED,
 * which only suspends an account). It removes:
 *   - every Organization the user owns, and by cascade its audits (+ findings,
 *     reports, files, datasets), members, subscription, usage counters, and
 *     ad accounts;
 *   - platform connections for those orgs, INCLUDING the encrypted OAuth
 *     access/refresh tokens — PlatformConnection has only a bare organizationId
 *     column with no Prisma relation, so deleting the org does NOT cascade to
 *     it; it must be deleted explicitly or the tokens would be orphaned;
 *   - the user row itself, cascading auth sessions, verification tokens,
 *     memberships, and business profiles.
 *
 * Runs in a single transaction so a partial failure leaves nothing half-deleted.
 * Note: deleting an owned Organization also removes data shared with any other
 * members of that org — which is the intended meaning of "delete my account and
 * all associated data" for the account owner.
 */
export const purgeUserAndOwnedData = async (userId) => {
  return prisma.$transaction(async (tx) => {
    const ownedOrgs = await tx.organization.findMany({
      where: { ownerId: userId },
      select: { id: true },
    });
    const orgIds = ownedOrgs.map((o) => o.id);

    let deletedConnections = 0;
    if (orgIds.length > 0) {
      // PlatformConnection is not part of the Organization cascade (no relation
      // field), so remove the encrypted tokens explicitly before the org goes.
      const conn = await tx.platformConnection.deleteMany({
        where: { organizationId: { in: orgIds } },
      });
      deletedConnections = conn.count;

      // Cascades: audits (+ all children), members, subscription, planOverride,
      // usageCounters, adAccounts, businessProfile.
      await tx.organization.deleteMany({ where: { ownerId: userId } });
    }

    // Cascades: authSessions, verificationTokens, memberships, businessProfiles.
    await tx.user.delete({ where: { id: userId } });

    return { deletedOrganizations: orgIds.length, deletedConnections };
  });
};
