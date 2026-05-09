import { prisma } from "../../lib/prisma.js";

/**
 * Returns trend points for completed audits in an organization. Each point
 * is a compact record suitable for plotting a sparkline or table — no
 * heavy includes, ordered chronologically by completion time.
 *
 * Optional filters:
 *   - adAccountId: limit to one ad account
 *   - platform: only include audits whose selectedPlatforms includes this
 *
 * Limited to the last `limit` records (default 20) so the dashboard can
 * render without paging.
 */
export const fetchAuditTrend = async ({
  organizationId,
  adAccountId,
  platform,
  limit = 20,
}) => {
  const where = {
    organizationId,
    status: "COMPLETED",
    completedAt: { not: null },
    ...(adAccountId ? { adAccountId } : {}),
    ...(platform ? { selectedPlatforms: { has: platform } } : {}),
  };

  // Pull the most recent `limit` audits (newest first) so the slice is
  // bounded, then reverse for chronological display.
  const audits = await prisma.audit.findMany({
    where,
    orderBy: { completedAt: "desc" },
    take: limit,
    select: {
      id: true,
      adAccountId: true,
      selectedPlatforms: true,
      healthScore: true,
      categoryScores: true,
      completedAt: true,
      createdAt: true,
      adAccount: { select: { id: true, name: true, platform: true } },
      memorySummary: { select: { summary: true } },
      ruleFindings: { select: { severity: true } },
    },
  });

  return audits
    .reverse()
    .map((audit) => {
      const severityCounts = audit.ruleFindings.reduce(
        (counts, finding) => {
          counts[finding.severity] = (counts[finding.severity] || 0) + 1;
          counts.total += 1;
          return counts;
        },
        { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, total: 0 }
      );

      return {
        auditId: audit.id,
        adAccount: audit.adAccount,
        selectedPlatforms: audit.selectedPlatforms,
        healthScore: audit.healthScore,
        categoryScores: audit.categoryScores,
        completedAt: audit.completedAt,
        createdAt: audit.createdAt,
        findingCounts: severityCounts,
        // Surface the memory summary so the frontend can deep-link or compare
        // without an extra round-trip — but only the small JSON, no rules.
        memorySummary: audit.memorySummary?.summary || null,
      };
    });
};

const safeNumber = (value) =>
  Number.isFinite(Number(value)) ? Number(value) : null;

/**
 * Compute deltas between two audits' summaries. Used by the compare page.
 * Both inputs are MemorySummary-style objects (or live audit slices).
 *
 * Returns an object of named deltas — each is { left, right, delta, deltaPct }
 * (deltaPct is null when left is 0 or undefined).
 */
const buildDelta = (left, right) => {
  const leftValue = safeNumber(left);
  const rightValue = safeNumber(right);
  if (leftValue == null || rightValue == null) {
    return { left: leftValue, right: rightValue, delta: null, deltaPct: null };
  }
  const delta = rightValue - leftValue;
  const deltaPct = leftValue === 0 ? null : (delta / leftValue) * 100;
  return {
    left: leftValue,
    right: rightValue,
    delta,
    deltaPct: deltaPct == null ? null : Number(deltaPct.toFixed(1)),
  };
};

/**
 * Builds a side-by-side comparison report for two audits.
 *
 * Both audits must belong to the same organization (callers enforce this
 * via the `where` clause). Returns the two audits' core scoring + finding
 * stats plus computed deltas. Throws if either audit isn't found.
 */
export const fetchAuditComparison = async ({
  organizationId,
  leftAuditId,
  rightAuditId,
}) => {
  const [left, right] = await Promise.all([
    prisma.audit.findFirst({
      where: { id: leftAuditId, organizationId },
      include: {
        adAccount: true,
        ruleFindings: true,
        normalizedDataset: { select: { summary: true } },
        memorySummary: { select: { summary: true } },
      },
    }),
    prisma.audit.findFirst({
      where: { id: rightAuditId, organizationId },
      include: {
        adAccount: true,
        ruleFindings: true,
        normalizedDataset: { select: { summary: true } },
        memorySummary: { select: { summary: true } },
      },
    }),
  ]);

  if (!left || !right) {
    return null;
  }

  const summarize = (audit) => {
    const findings = audit.ruleFindings || [];
    const severityCounts = findings.reduce(
      (counts, finding) => {
        counts[finding.severity] = (counts[finding.severity] || 0) + 1;
        return counts;
      },
      { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 }
    );
    const totals = audit.normalizedDataset?.summary?.totals || {};

    return {
      auditId: audit.id,
      adAccount: audit.adAccount
        ? {
            id: audit.adAccount.id,
            name: audit.adAccount.name,
            platform: audit.adAccount.platform,
          }
        : null,
      selectedPlatforms: audit.selectedPlatforms,
      status: audit.status,
      healthScore: audit.healthScore,
      categoryScores: audit.categoryScores,
      completedAt: audit.completedAt,
      createdAt: audit.createdAt,
      findingCounts: {
        total: findings.length,
        ...severityCounts,
      },
      spend: safeNumber(totals.spend),
      impressions: safeNumber(totals.impressions),
      clicks: safeNumber(totals.clicks),
      conversions: safeNumber(totals.conversions),
      ruleIds: findings.map((finding) => finding.ruleId),
      memorySummary: audit.memorySummary?.summary || null,
    };
  };

  const leftSummary = summarize(left);
  const rightSummary = summarize(right);

  // Symmetric difference of rule IDs — what's new on the right, and what
  // was resolved (i.e. on left only).
  const leftRuleSet = new Set(leftSummary.ruleIds);
  const rightRuleSet = new Set(rightSummary.ruleIds);
  const newRules = rightSummary.ruleIds.filter(
    (ruleId) => !leftRuleSet.has(ruleId)
  );
  const resolvedRules = leftSummary.ruleIds.filter(
    (ruleId) => !rightRuleSet.has(ruleId)
  );
  const persistedRules = rightSummary.ruleIds.filter((ruleId) =>
    leftRuleSet.has(ruleId)
  );

  return {
    left: leftSummary,
    right: rightSummary,
    deltas: {
      healthScore: buildDelta(leftSummary.healthScore, rightSummary.healthScore),
      totalFindings: buildDelta(
        leftSummary.findingCounts.total,
        rightSummary.findingCounts.total
      ),
      critical: buildDelta(
        leftSummary.findingCounts.CRITICAL,
        rightSummary.findingCounts.CRITICAL
      ),
      high: buildDelta(
        leftSummary.findingCounts.HIGH,
        rightSummary.findingCounts.HIGH
      ),
      medium: buildDelta(
        leftSummary.findingCounts.MEDIUM,
        rightSummary.findingCounts.MEDIUM
      ),
      low: buildDelta(
        leftSummary.findingCounts.LOW,
        rightSummary.findingCounts.LOW
      ),
      spend: buildDelta(leftSummary.spend, rightSummary.spend),
      impressions: buildDelta(leftSummary.impressions, rightSummary.impressions),
      clicks: buildDelta(leftSummary.clicks, rightSummary.clicks),
      conversions: buildDelta(leftSummary.conversions, rightSummary.conversions),
    },
    rulesDiff: {
      new: newRules,
      resolved: resolvedRules,
      persisted: persistedRules,
    },
  };
};
