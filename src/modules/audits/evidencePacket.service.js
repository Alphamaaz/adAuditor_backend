/**
 * Evidence Packet — curated, verified deterministic facts for the AI layer.
 *
 * The packet is the ONLY thing the narrative model should reason over. It
 * contains no raw rows and no invented numbers — every figure here was
 * produced by the deterministic engine. This is what keeps the LLM honest:
 * it narrates the packet, it does not compute from raw data.
 *
 * Design rules:
 *   - No raw row data.
 *   - Findings ranked by leverage: severity first, then confidence, then dollar
 *     impact within a severity band (see lib/findings/priority.js).
 *   - Evidence fields carried through verbatim so the model can cite real numbers.
 *   - A flat `verifiedNumbers` set of dollar magnitudes for the fact-check pass.
 */

import {
  deriveKpis,
  normalizeSnapshotFromMemory,
  buildComparisonFacts,
} from "../../lib/comparison/auditComparison.js";
import { byLeverageDesc } from "../../lib/findings/priority.js";

const MAX_FINDINGS = 25;
const MAX_PRIOR_AUDITS = 3;

const MONEY_RX =
  /(?:\$|USD|PKR|EUR|GBP|CAD|AUD|AED|INR|SAR|QAR|KWD|SGD|MYR|THB|PHP|IDR|BDT|LKR|NPR|ZAR)\s?([\d,]+(?:\.\d+)?)/g;

/**
 * Parse the leading dollar magnitude from an estimatedImpact string so we can
 * rank findings by money. "$4,280 in waste…" → 4280. Returns 0 when none.
 */
const parseImpactDollars = (impact) => {
  if (typeof impact !== "string") return 0;
  MONEY_RX.lastIndex = 0;
  const match = MONEY_RX.exec(impact);
  if (!match) return 0;
  const n = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
};

/**
 * Collect every dollar magnitude that appears anywhere in the verified
 * inputs (finding evidence, estimatedImpact, summary totals, business
 * profile targets). The fact-check pass uses this to detect invented figures.
 */
const collectVerifiedNumbers = ({ findings, summary, businessProfile }) => {
  const numbers = new Set();

  const addFromString = (str) => {
    if (typeof str !== "string") return;
    let m;
    MONEY_RX.lastIndex = 0;
    while ((m = MONEY_RX.exec(str)) !== null) {
      const n = Math.round(Number(m[1].replace(/,/g, "")));
      if (Number.isFinite(n)) numbers.add(n);
    }
  };

  const addNumber = (value) => {
    const n = Math.round(Number(value));
    if (Number.isFinite(n) && n > 0) numbers.add(n);
  };

  for (const f of findings) {
    addFromString(f.estimatedImpact);
    addFromString(f.detail);
    addFromString(f.title);
    if (f.evidence && typeof f.evidence === "object") {
      for (const v of Object.values(f.evidence)) {
        if (typeof v === "number") addNumber(v);
        else if (typeof v === "string") addFromString(v);
      }
    }
  }

  const totals = summary?.totals || {};
  addNumber(totals.spend);
  addNumber(totals.conversions);
  for (const p of Object.values(summary?.platforms || {})) {
    addNumber(p?.spend);
    addNumber(p?.conversions);
    addNumber(p?.clicks);
    addNumber(p?.impressions);
  }

  const a = businessProfile?.sectionA || {};
  addNumber(a.monthlyBudget);
  addNumber(a.targetCpa);
  addNumber(a.avgOrderValue);
  addNumber(a.blendedCac);

  return [...numbers].sort((x, y) => x - y);
};

const compactFinding = (finding) => ({
  ruleId: finding.ruleId,
  platform: finding.platform,
  severity: finding.severity,
  category: finding.category,
  title: finding.title,
  detail: finding.detail,
  evidence: finding.evidence,
  estimatedImpact: finding.estimatedImpact,
  estimatedImpactDollars: parseImpactDollars(finding.estimatedImpact),
  fixSteps: finding.fixSteps,
});

const compactIntake = (intakeResponses) =>
  (intakeResponses || []).reduce((acc, response) => {
    acc[response.section] = response.answers;
    return acc;
  }, {});

/**
 * Tracking / data-confidence note. Several rules flag tracking failures;
 * when present, ROAS/CPA numbers are unreliable and the narrative must say so.
 */
const buildDataConfidence = (findings, uploadReadiness) => {
  const trackingRuleIds = new Set([
    "BP-TRK-001",
    "BP-TRK-002",
    "BP-TRK-003",
    "BP-TRK-004",
    "META-CAPI-MATCH-001",
  ]);
  const trackingFindings = findings.filter((f) =>
    trackingRuleIds.has(f.ruleId)
  );
  return {
    mode: uploadReadiness?.mode || uploadReadiness?.status || null,
    trackingIssuesDetected: trackingFindings.length,
    metricsReliable: trackingFindings.length === 0,
    note:
      trackingFindings.length > 0
        ? "Tracking issues detected — CPA and ROAS figures are unreliable until resolved."
        : "No tracking issues detected in this audit.",
  };
};

/**
 * Build the evidence packet from a completed audit + prior memory summaries.
 * Pure — no DB calls. Caller supplies priorAudits.
 */
export const buildEvidencePacket = (audit, { priorAudits = [] } = {}) => {
  const findings = audit.ruleFindings || [];
  const summary = audit.normalizedDataset?.summary || null;
  const businessProfile = audit.businessProfileSnapshot || null;

  // Leverage ranking: severity → confidence → dollars. A rate-severe CRITICAL
  // on a smaller-spend campaign must lead a larger-dollar MEDIUM, not trail it.
  const sortedFindings = [...findings].sort((a, b) => {
    const lev = byLeverageDesc(a, b);
    if (lev !== 0) return lev;
    return (
      parseImpactDollars(b.estimatedImpact) -
      parseImpactDollars(a.estimatedImpact)
    );
  });

  const topFindings = sortedFindings.slice(0, MAX_FINDINGS).map(compactFinding);

  // Deterministic comparison facts (self-over-time + peer) for the narrative.
  // priorAudits are stored memory summaries. Safe with none → null blocks.
  const totals = summary?.totals || {};
  const currentSnapshot = {
    auditId: audit.id,
    adAccountId: audit.adAccountId || null,
    adAccountName: audit.adAccount?.name || null,
    completedAt: audit.completedAt || null,
    platforms: audit.selectedPlatforms || [],
    primaryPlatform: (audit.selectedPlatforms || [])[0] || null,
    businessType: businessProfile?.sectionA?.businessType || null,
    spend: Number(totals.spend) || 0,
    impressions: Number(totals.impressions) || 0,
    clicks: Number(totals.clicks) || 0,
    conversions: Number(totals.conversions) || 0,
    kpis: deriveKpis({
      spend: totals.spend,
      impressions: totals.impressions,
      clicks: totals.clicks,
      conversions: totals.conversions,
    }),
    healthScore: audit.healthScore ?? null,
    criticalRuleIds: findings
      .filter((f) => f.severity === "CRITICAL")
      .map((f) => f.ruleId),
  };
  const priorSnapshots = (priorAudits || []).map(normalizeSnapshotFromMemory);
  const comparison = buildComparisonFacts({
    current: currentSnapshot,
    priorSnapshots,
  });

  return {
    schemaVersion: 1,
    audit: {
      id: audit.id,
      selectedPlatforms: audit.selectedPlatforms || [],
      dataSource: audit.dataSource || null,
      healthScore: audit.healthScore ?? null,
      categoryScores: audit.categoryScores ?? null,
    },
    businessProfile: businessProfile?.sectionA
      ? {
          businessType: businessProfile.sectionA.businessType ?? null,
          monthlyBudget: businessProfile.sectionA.monthlyBudget ?? null,
          targetCpa: businessProfile.sectionA.targetCpa ?? null,
          targetRoas: businessProfile.sectionA.targetRoas ?? null,
          avgOrderValue: businessProfile.sectionA.avgOrderValue ?? null,
          blendedCac: businessProfile.sectionA.blendedCac ?? null,
          brandTerms: businessProfile.sectionA.brandTerms ?? null,
          mainGoal: businessProfile.sectionA.mainGoal ?? null,
        }
      : null,
    normalizedSummary: summary,
    intakeResponses: compactIntake(audit.intakeResponses),
    topFindings,
    findingCounts: {
      total: findings.length,
      critical: findings.filter((f) => f.severity === "CRITICAL").length,
      high: findings.filter((f) => f.severity === "HIGH").length,
      medium: findings.filter((f) => f.severity === "MEDIUM").length,
      low: findings.filter((f) => f.severity === "LOW").length,
    },
    dataConfidence: buildDataConfidence(findings, audit.uploadReadiness),
    priorAudits: priorAudits.slice(0, MAX_PRIOR_AUDITS),
    comparison,
    verifiedNumbers: collectVerifiedNumbers({
      findings,
      summary,
      businessProfile,
    }),
    contextLimits: {
      maxFindingsSent: MAX_FINDINGS,
      maxPriorAudits: MAX_PRIOR_AUDITS,
      rawRowsIncluded: false,
      rawFilesIncluded: false,
    },
  };
};

export const __test__ = { parseImpactDollars, collectVerifiedNumbers };
