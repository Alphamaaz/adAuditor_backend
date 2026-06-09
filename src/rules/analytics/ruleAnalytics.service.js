/**
 * Rule analytics service.
 *
 * Read-only Prisma queries over RuleExecution + RuleFinding +
 * RecommendationFeedback. Returns shapes ready for an admin dashboard.
 *
 * These are intentionally raw queries with explicit indexes — they read
 * from the same tables the orchestrator writes to, so be careful with
 * unbounded scans.
 *
 * All functions accept an optional { since, until } window. Defaults to
 * the last 30 days.
 */

import { prisma } from "../../lib/prisma.js";
import {
  RESOLVED_RATINGS,
  DISMISSED_RATINGS,
} from "../../modules/audits/recommendationFeedback.constants.js";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

const defaultWindow = ({ since, until } = {}) => ({
  since: since ?? new Date(Date.now() - THIRTY_DAYS_MS),
  until: until ?? new Date(),
});

/**
 * Most-fired rules over a window.
 * Returns: [{ ruleId, fired, passed, errored, fireRate }]
 */
export const mostFiredRules = async (opts = {}) => {
  const { since, until } = defaultWindow(opts);
  const rows = await prisma.ruleExecution.groupBy({
    by: ["ruleId", "status"],
    where: { createdAt: { gte: since, lte: until } },
    _count: { _all: true },
  });

  const byRule = new Map();
  for (const row of rows) {
    const entry =
      byRule.get(row.ruleId) ?? { ruleId: row.ruleId, fired: 0, passed: 0, errored: 0, skipped: 0 };
    if (row.status === "FIRED") entry.fired = row._count._all;
    if (row.status === "PASSED") entry.passed = row._count._all;
    if (row.status === "ERROR") entry.errored = row._count._all;
    if (row.status === "SKIPPED") entry.skipped = row._count._all;
    byRule.set(row.ruleId, entry);
  }

  return [...byRule.values()]
    .map((entry) => {
      const evaluated = entry.fired + entry.passed + entry.errored;
      return {
        ...entry,
        fireRate: evaluated > 0 ? entry.fired / evaluated : 0,
      };
    })
    .sort((a, b) => b.fired - a.fired);
};

/**
 * Highest-dismissed rules (false-positive candidates).
 * A finding is "dismissed" when RecommendationFeedback.rating in {"DISMISSED","NOT_HELPFUL"}.
 * Returns: [{ ruleId, totalFindings, dismissals, dismissalRate }]
 */
export const mostDismissedRules = async (opts = {}) => {
  const { since, until } = defaultWindow(opts);

  const findings = await prisma.ruleFinding.groupBy({
    by: ["ruleId"],
    where: { createdAt: { gte: since, lte: until } },
    _count: { _all: true },
  });

  // RecommendationFeedback links by auditId + recommendationId (string).
  // Findings join: recommendationId === finding.id.
  const dismissals = await prisma.$queryRaw`
    SELECT rf."ruleId" AS "ruleId", COUNT(*)::int AS dismissals
    FROM "RuleFinding" rf
    JOIN "RecommendationFeedback" fb
      ON fb."recommendationId" = rf.id
    WHERE fb."rating" = ANY(${DISMISSED_RATINGS}::text[])
      AND rf."createdAt" BETWEEN ${since} AND ${until}
    GROUP BY rf."ruleId"
  `;

  const dismissalsByRule = new Map(
    dismissals.map((row) => [row.ruleId, row.dismissals])
  );

  return findings
    .map((f) => {
      const dCount = dismissalsByRule.get(f.ruleId) ?? 0;
      const total = f._count._all;
      return {
        ruleId: f.ruleId,
        totalFindings: total,
        dismissals: dCount,
        dismissalRate: total > 0 ? dCount / total : 0,
      };
    })
    .sort((a, b) => b.dismissalRate - a.dismissalRate);
};

/**
 * Highest-resolved rules (perceived-value winners).
 * A finding is "resolved" when RecommendationFeedback.rating in {"RESOLVED","FIXED","HELPFUL"}.
 * Returns: [{ ruleId, totalFindings, resolved, resolutionRate }]
 */
export const highestResolvedRules = async (opts = {}) => {
  const { since, until } = defaultWindow(opts);

  const findings = await prisma.ruleFinding.groupBy({
    by: ["ruleId"],
    where: { createdAt: { gte: since, lte: until } },
    _count: { _all: true },
  });

  const resolutions = await prisma.$queryRaw`
    SELECT rf."ruleId" AS "ruleId", COUNT(*)::int AS resolved
    FROM "RuleFinding" rf
    JOIN "RecommendationFeedback" fb
      ON fb."recommendationId" = rf.id
    WHERE fb."rating" = ANY(${RESOLVED_RATINGS}::text[])
      AND rf."createdAt" BETWEEN ${since} AND ${until}
    GROUP BY rf."ruleId"
  `;

  const resolvedByRule = new Map(
    resolutions.map((row) => [row.ruleId, row.resolved])
  );

  return findings
    .map((f) => {
      const r = resolvedByRule.get(f.ruleId) ?? 0;
      const total = f._count._all;
      return {
        ruleId: f.ruleId,
        totalFindings: total,
        resolved: r,
        resolutionRate: total > 0 ? r / total : 0,
      };
    })
    .sort((a, b) => b.resolutionRate - a.resolutionRate);
};

/**
 * Estimated savings — parses dollar amounts out of finding.estimatedImpact.
 * Loose regex; intended as a directional metric, not finance-grade.
 * Returns: [{ ruleId, totalFindings, totalEstimatedSavings }]
 */
const MONEY_RX =
  /(?:\$|USD|PKR|EUR|GBP|CAD|AUD|AED|INR|SAR|QAR|KWD|SGD|MYR|THB|PHP|IDR|BDT|LKR|NPR|ZAR)\s?([\d,]+(?:\.\d+)?)/;

export const estimatedSavingsByRule = async (opts = {}) => {
  const { since, until } = defaultWindow(opts);

  const findings = await prisma.ruleFinding.findMany({
    where: { createdAt: { gte: since, lte: until } },
    select: { ruleId: true, estimatedImpact: true },
  });

  const byRule = new Map();
  for (const f of findings) {
    const entry =
      byRule.get(f.ruleId) ?? {
        ruleId: f.ruleId,
        totalFindings: 0,
        totalEstimatedSavings: 0,
      };
    entry.totalFindings += 1;
    const match = f.estimatedImpact?.match(MONEY_RX);
    if (match) {
      const amount = Number(match[1].replace(/,/g, ""));
      if (Number.isFinite(amount)) entry.totalEstimatedSavings += amount;
    }
    byRule.set(f.ruleId, entry);
  }

  return [...byRule.values()].sort(
    (a, b) => b.totalEstimatedSavings - a.totalEstimatedSavings
  );
};

/**
 * False-positive rate per rule (heuristic).
 * Defined as dismissalRate where totalFindings >= MIN_SAMPLE.
 * Returns: [{ ruleId, totalFindings, dismissals, falsePositiveRate }]
 */
export const falsePositiveRateByRule = async (opts = {}) => {
  const dismissed = await mostDismissedRules(opts);
  const MIN_SAMPLE = opts.minSample ?? 10;
  return dismissed
    .filter((r) => r.totalFindings >= MIN_SAMPLE)
    .map((r) => ({
      ruleId: r.ruleId,
      totalFindings: r.totalFindings,
      dismissals: r.dismissals,
      falsePositiveRate: r.dismissalRate,
    }))
    .sort((a, b) => b.falsePositiveRate - a.falsePositiveRate);
};

/**
 * Performance percentiles per rule (p50/p95).
 * Returns: [{ ruleId, samples, p50, p95, maxMs }]
 */
export const performanceByRule = async (opts = {}) => {
  const { since, until } = defaultWindow(opts);
  const rows = await prisma.$queryRaw`
    SELECT
      "ruleId",
      COUNT(*)::int AS samples,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY "durationMs") AS p50,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY "durationMs") AS p95,
      MAX("durationMs")::int AS "maxMs"
    FROM "RuleExecution"
    WHERE "createdAt" BETWEEN ${since} AND ${until}
      AND "status" IN ('FIRED','PASSED')
    GROUP BY "ruleId"
    ORDER BY p95 DESC
  `;
  return rows;
};

/**
 * Rule performance broken down by business type (from businessProfileSnapshot.sectionA.businessType).
 * Heavy query — paginate / cache for dashboards.
 * Returns: [{ ruleId, businessType, fired, totalAudits, fireRate }]
 */
export const performanceByIndustry = async (opts = {}) => {
  const { since, until } = defaultWindow(opts);
  const rows = await prisma.$queryRaw`
    SELECT
      re."ruleId" AS "ruleId",
      COALESCE(a."businessProfileSnapshot"->'sectionA'->>'businessType', 'Unknown') AS "businessType",
      SUM(CASE WHEN re."status" = 'FIRED' THEN 1 ELSE 0 END)::int AS fired,
      COUNT(DISTINCT re."auditId")::int AS "totalAudits"
    FROM "RuleExecution" re
    JOIN "Audit" a ON a.id = re."auditId"
    WHERE re."createdAt" BETWEEN ${since} AND ${until}
    GROUP BY re."ruleId", "businessType"
    ORDER BY "ruleId", fired DESC
  `;
  return rows.map((r) => ({
    ...r,
    fireRate: r.totalAudits > 0 ? r.fired / r.totalAudits : 0,
  }));
};
