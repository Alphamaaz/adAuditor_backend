import { prisma } from "../../lib/prisma.js";

/**
 * Build a compact, durable summary of a completed audit. The shape is
 * intentionally small and stable: it gets stored as JSON on
 * AuditMemorySummary and included in future AI contexts so the model can
 * reference prior audits ("your CPA dropped 15% since last audit").
 *
 * Keep this output PRD-aligned:
 *   - No raw rows
 *   - No free-form narrative
 *   - Only deterministic facts derived from the engine's output
 */
const SEVERITY_KEYS = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];

const countBy = (items, getKey) =>
  items.reduce((acc, item) => {
    const key = getKey(item);
    if (!key) return acc;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

const topRules = (findings, limit = 5) => {
  const severityRank = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
  return [...findings]
    .sort(
      (left, right) =>
        (severityRank[right.severity] || 0) -
        (severityRank[left.severity] || 0)
    )
    .slice(0, limit)
    .map((finding) => ({
      ruleId: finding.ruleId,
      platform: finding.platform,
      severity: finding.severity,
      category: finding.category,
      title: finding.title,
    }));
};

const safeNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : null;
};

/**
 * Pure builder — does not write to the database. Useful for previews and
 * testing.
 */
export const buildAuditMemorySummary = (audit) => {
  const findings = audit.ruleFindings || [];
  const datasetSummary = audit.normalizedDataset?.summary || null;
  const totals = datasetSummary?.totals || {};
  const platformSummaries = datasetSummary?.platforms || {};

  const severityCounts = SEVERITY_KEYS.reduce((acc, severity) => {
    acc[severity] = 0;
    return acc;
  }, {});
  for (const finding of findings) {
    if (severityCounts[finding.severity] != null) {
      severityCounts[finding.severity] += 1;
    }
  }

  return {
    auditId: audit.id,
    completedAt: audit.completedAt,
    selectedPlatforms: audit.selectedPlatforms || [],
    dataSource: audit.dataSource || null,
    healthScore: audit.healthScore ?? null,
    categoryScores: audit.categoryScores ?? null,
    findingCounts: {
      total: findings.length,
      bySeverity: severityCounts,
      byPlatform: countBy(findings, (finding) => finding.platform),
      byCategory: countBy(findings, (finding) => finding.category),
    },
    topRules: topRules(findings),
    spendTotals: {
      total: safeNumber(totals.spend),
      currency: Object.values(platformSummaries)[0]?.currency || null,
      byPlatform: Object.fromEntries(
        Object.entries(platformSummaries).map(([platform, summary]) => [
          platform,
          {
            spend: safeNumber(summary?.spend),
            impressions: safeNumber(summary?.impressions),
            clicks: safeNumber(summary?.clicks),
            conversions: safeNumber(summary?.conversions),
            currency: summary?.currency || null,
          },
        ])
      ),
    },
    uploadReadiness:
      audit.uploadReadiness?.mode || audit.uploadReadiness?.status || null,
    schemaVersion: 1,
  };
};

/**
 * Persist the summary to AuditMemorySummary (upsert). Best-effort — a
 * failure here should never block the audit from being marked COMPLETED.
 */
export const writeAuditMemorySummary = async (auditId) => {
  const audit = await prisma.audit.findUnique({
    where: { id: auditId },
    include: {
      ruleFindings: true,
      normalizedDataset: true,
    },
  });

  if (!audit) return null;

  const summary = buildAuditMemorySummary(audit);

  return prisma.auditMemorySummary.upsert({
    where: { auditId },
    create: { auditId, summary },
    update: { summary },
  });
};

/**
 * Returns the most recent N memory summaries for an organization, EXCLUDING
 * the audit currently being processed (so the AI doesn't reference itself).
 */
export const fetchRecentMemorySummaries = async ({
  organizationId,
  excludeAuditId,
  limit = 3,
}) => {
  const summaries = await prisma.auditMemorySummary.findMany({
    where: {
      audit: {
        organizationId,
        status: "COMPLETED",
        ...(excludeAuditId ? { id: { not: excludeAuditId } } : {}),
      },
    },
    include: {
      audit: { select: { id: true, completedAt: true, adAccountId: true } },
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  return summaries.map((row) => row.summary);
};
