/**
 * Deep Audit — deterministic tool layer.   (spec: docs/DEEP_AUDIT_SPEC.md)
 *
 * These are the ONLY way the agentic Deep Audit model may obtain numbers. Every
 * tool is a thin wrapper over deterministic code that already exists; the LLM
 * never computes. Hard invariants enforced here:
 *   - No tool returns raw ad rows — computed aggregates only.
 *   - No tool writes anything (read-only).
 *   - Pure over an in-memory audit bundle → reproducible + unit-testable
 *     without a database or an LLM.
 *
 * Nothing here is wired into the production pipeline. The agent subsystem is
 * reachable only behind DEEP_AUDIT_ENABLED; this module is inert until an
 * orchestrator calls it.
 */

import { buildEvidencePacket } from "../evidencePacket.service.js";
import { buildCurrentSnapshot } from "../comparisonFindings.service.js";
import {
  baseMetrics,
  decomposeCpa,
  decomposeRoas,
  diagnoseCpaDriver,
  diagnoseRoasDriver,
} from "../../../lib/kpi/decomposition.js";
import {
  analyzeDimension,
  baselineCpa as computeBaselineCpa,
} from "../../../lib/segments/contributionAnalysis.js";
import { isSignificant } from "../../../lib/stats/significance.js";
import {
  normalizeSnapshotFromMemory,
  pickPeer,
  peerComparison,
  memoryDelta,
} from "../../../lib/comparison/auditComparison.js";
import { getBenchmark } from "../auditEngine.service.js";
import { byLeverageDesc } from "../../../lib/findings/priority.js";

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

const MONEY_RX =
  /(?:\$|USD|PKR|EUR|GBP|CAD|AUD|AED|INR|SAR|QAR|KWD|SGD|MYR|THB|PHP|IDR|BDT|LKR|NPR|ZAR)\s?([\d,]+(?:\.\d+)?)/;

const formatMoney = (value, currency) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const formatted = Math.round(n).toLocaleString("en-US");
  return currency && currency !== "USD" ? `${currency} ${formatted}` : `$${formatted}`;
};

const parseImpactDollars = (impact) => {
  if (typeof impact !== "string") return 0;
  const m = impact.match(MONEY_RX);
  if (!m) return 0;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
};

const primaryPlatform = (audit) => (audit?.selectedPlatforms || [])[0] || null;

const businessTypeOf = (audit) =>
  audit?.businessProfileSnapshot?.sectionA?.businessType || "Other";

const platformData = (audit, platform) =>
  audit?.normalizedDataset?.data?.platforms?.[platform] || null;

const reportCurrency = (audit, platform) => {
  const direct = platform && audit?.normalizedDataset?.summary?.platforms?.[platform]?.currency;
  if (direct) return direct;
  const platforms = audit?.normalizedDataset?.summary?.platforms || {};
  for (const summary of Object.values(platforms)) {
    if (summary?.currency) return summary.currency;
  }
  return audit?.normalizedDataset?.summary?.totals?.currency || "USD";
};

const accountTotals = (audit) => {
  const totals = audit?.normalizedDataset?.summary?.totals || {};
  const bp = audit?.businessProfileSnapshot?.sectionA || {};
  const conversions = num(totals.conversions);
  const aov = num(bp.avgOrderValue);
  return {
    spend: num(totals.spend),
    impressions: num(totals.impressions),
    clicks: num(totals.clicks),
    conversions,
    // Revenue is inferred only when AOV is declared — never invented.
    revenue: aov > 0 && conversions > 0 ? aov * conversions : null,
  };
};

const buildSnapshots = ({ audit, priorAudits }) => {
  const current = buildCurrentSnapshot({
    audit,
    scores: { overall: audit?.healthScore ?? null },
    dataset: audit?.normalizedDataset || null,
  });
  const priors = (priorAudits || []).map(normalizeSnapshotFromMemory);
  return { current, priors };
};

const mostRecentSameAccount = (current, priors) =>
  priors
    .filter((s) => s.adAccountId && s.adAccountId === current.adAccountId)
    .sort(
      (a, b) =>
        new Date(b.completedAt || 0).getTime() -
        new Date(a.completedAt || 0).getTime()
    )[0] || null;

/**
 * Build the deterministic tool set bound to one audit bundle. Pure: same bundle
 * in → same numbers out. No DB, no LLM, no writes.
 *
 * @param {object} bundle
 * @param {object} bundle.audit         audit with ruleFindings, normalizedDataset,
 *                                       businessProfileSnapshot, selectedPlatforms…
 * @param {Array}  [bundle.priorAudits] stored memory summaries for comparison
 */
export const createDeepAuditTools = ({ audit, priorAudits = [] } = {}) => {
  if (!audit) throw new Error("createDeepAuditTools requires an audit");

  const getEvidencePacket = () => buildEvidencePacket(audit, { priorAudits });

  const getPeerComparison = () => {
    const { current, priors } = buildSnapshots({ audit, priorAudits });
    const peerPick = pickPeer({ current, candidates: priors });
    if (!peerPick) return { available: false, reason: "no_eligible_peer" };
    return {
      available: true,
      matchReasons: peerPick.reasons,
      ...peerComparison({ current, peer: peerPick.peer }),
    };
  };

  const getMemoryDelta = () => {
    const { current, priors } = buildSnapshots({ audit, priorAudits });
    const previous = mostRecentSameAccount(current, priors);
    if (!previous) return { available: false, reason: "no_prior_audit" };
    return { available: true, ...memoryDelta({ current, previous }) };
  };

  const decomposeKpi = ({ kpi = "CPA" } = {}) => {
    const totals = accountTotals(audit);
    const actual = baseMetrics(totals);
    const bp = audit?.businessProfileSnapshot?.sectionA || {};
    const metric = String(kpi).toUpperCase();

    if (metric === "ROAS") {
      return {
        metric,
        base: actual,
        decomposition: decomposeRoas({
          aov: num(bp.avgOrderValue) || null,
          cvr: actual.cvr,
          cpc: actual.cpc,
          roas: actual.roas,
        }),
        diagnosis: diagnoseRoasDriver({
          actualRoas: actual.roas,
          targetRoas: num(bp.targetRoas) || null,
          aov: num(bp.avgOrderValue) || null,
          cvr: actual.cvr,
          cpc: actual.cpc,
        }),
        referenceSource: "none",
        comparison: {
          available: false,
          note: "ROAS driver shares are magnitude-only; rely on the target-based diagnosis, not a single dominant driver.",
        },
      };
    }

    // CPA / CPR (messaging) — same driver math: CPM × CTR × CVR. Reference =
    // the matched peer (the Essa-vs-Umeed comparison) so the dominant driver is
    // peer-relative. The benchmark-based diagnosis is reported alongside it.
    const { current, priors } = buildSnapshots({ audit, priorAudits });
    const peerPick = pickPeer({ current, candidates: priors });
    let reference = null;
    let referenceSource = "none";
    if (peerPick?.peer) {
      const p = peerPick.peer;
      reference = baseMetrics({
        spend: p.spend,
        impressions: p.impressions,
        clicks: p.clicks,
        conversions: p.conversions,
      });
      referenceSource = `peer:${p.adAccountName || p.auditId}`;
    }

    const ctrBenchmark = getBenchmark("ctr", primaryPlatform(audit), businessTypeOf(audit));
    const decomposition = decomposeCpa(actual, reference);
    // A driver attribution is only trustworthy with a real baseline AND a
    // material gap. No peer (hasReference false) or a near-identical peer
    // (<3% CPA gap) → the "dominant driver" is noise; flag it so the model
    // doesn't present it as the root cause.
    const refCpa = reference?.cpa;
    const cpaGapPct =
      refCpa && actual.cpa ? Math.abs((actual.cpa - refCpa) / refCpa) : null;
    const meaningfulReference =
      decomposition?.hasReference === true && cpaGapPct != null && cpaGapPct >= 0.03;
    return {
      metric,
      base: actual,
      decomposition,
      diagnosis: diagnoseCpaDriver({
        actualCpa: actual.cpa,
        targetCpa: num(bp.targetCpa) || null,
        actualCtr: actual.ctr != null ? +(actual.ctr * 100).toFixed(3) : null,
        benchmarkCtrWarning: ctrBenchmark?.warning ?? null,
        benchmarkCtrGood: ctrBenchmark?.good ?? null,
      }),
      referenceSource,
      comparison: meaningfulReference
        ? {
            available: true,
            source: referenceSource,
            cpaGapPct: +(cpaGapPct * 100).toFixed(1),
          }
        : {
            available: false,
            note: decomposition?.hasReference
              ? "The comparison baseline is within ~3% of this account — the gap is negligible, so driver attribution would be noise. Do not name a dominant driver; rely on the benchmark diagnosis and the deterministic findings."
              : "No comparable peer account was available, so the driver shares are magnitude-only — NOT a measured gap vs a baseline. Do not name a single dominant driver as the root cause; rely on the benchmark diagnosis and the deterministic findings, and state plainly that no peer comparison was available.",
          },
    };
  };

  const analyzeSegments = ({ dimension } = {}) => {
    const platform = primaryPlatform(audit);
    const pd = platformData(audit, platform);
    const byDimension = pd?.byDimension || {};
    const dims = (dimension ? [dimension] : Object.keys(byDimension)).filter(
      (d) => Array.isArray(byDimension[d]) && byDimension[d].length > 0
    );
    if (dims.length === 0) return { available: false, reason: "no_breakdown_data" };

    const currency = reportCurrency(audit, platform);
    const totals = accountTotals(audit);
    const baseCpa = computeBaselineCpa({
      spend: totals.spend,
      conversions: totals.conversions,
    });
    const decorateSegment = (segment) => ({
      ...segment,
      currency,
      spendFormatted: formatMoney(segment.spend, currency),
      cpaFormatted: segment.cpa != null ? formatMoney(segment.cpa, currency) : null,
      baselineCpaFormatted:
        segment.baselineCpa != null ? formatMoney(segment.baselineCpa, currency) : null,
      wastedSpendFormatted: formatMoney(segment.wastedSpend, currency),
    });
    const dimensions = dims.map((d) => {
      const analysis = analyzeDimension({
        dimension: d,
        records: byDimension[d],
        baselineCpa: baseCpa,
      });
      return {
        ...analysis,
        currency,
        baselineCpaFormatted:
          analysis.baselineCpa != null ? formatMoney(analysis.baselineCpa, currency) : null,
        totalWasteFormatted: formatMoney(analysis.totalWaste, currency),
        segments: analysis.segments.map(decorateSegment),
        worst: analysis.worst ? decorateSegment(analysis.worst) : null,
      };
    });
    // Headline = dimension carrying the most confident wasted spend.
    const headline = [...dimensions].sort((a, b) => b.totalWaste - a.totalWaste)[0];
    return {
      available: true,
      currency,
      baselineCpa: baseCpa,
      baselineCpaFormatted: baseCpa != null ? formatMoney(baseCpa, currency) : null,
      dimensions,
      headline,
    };
  };

  /**
   * Break spend / impressions / conversions down by campaign type (Search,
   * Performance Max, Display, Shopping, Demand Gen, Video, ...). Resolves WHERE
   * spend and results actually come from — e.g. when active keywords show ~0
   * impressions yet the account spends and converts (the answer is usually PMax
   * or Display). Reads the already-pulled campaign records; no extra data needed.
   */
  const analyzeCampaignTypes = () => {
    const platform = primaryPlatform(audit);
    const pd = platformData(audit, platform);
    const campaigns = pd?.byLevel?.campaign || [];
    if (!campaigns.length) return { available: false, reason: "no_campaign_data" };

    const currency = reportCurrency(audit, platform);
    const round = (n, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;
    const byType = {};
    for (const c of campaigns) {
      const type = c.objective || c.advertisingChannelType || c.type || c.campaignType || "UNKNOWN";
      const t = (byType[type] ||= {
        channelType: type,
        spend: 0,
        impressions: 0,
        clicks: 0,
        conversions: 0,
        campaignCount: 0,
      });
      t.spend += num(c.spend);
      t.impressions += num(c.impressions);
      t.clicks += num(c.clicks);
      t.conversions += num(c.results ?? c.conversions);
      t.campaignCount += 1;
    }

    const totalSpend = Object.values(byType).reduce((s, t) => s + t.spend, 0);
    const totalConversions = Object.values(byType).reduce((s, t) => s + t.conversions, 0);
    const types = Object.values(byType)
      .map((t) => ({
        channelType: t.channelType,
        campaignCount: t.campaignCount,
        spend: round(t.spend),
        spendFormatted: formatMoney(t.spend, currency),
        impressions: t.impressions,
        clicks: t.clicks,
        conversions: t.conversions,
        cpa: t.conversions > 0 ? round(t.spend / t.conversions) : null,
        cpaFormatted:
          t.conversions > 0 ? formatMoney(t.spend / t.conversions, currency) : null,
        spendSharePct: totalSpend > 0 ? round((t.spend / totalSpend) * 100, 1) : 0,
        conversionSharePct:
          totalConversions > 0 ? round((t.conversions / totalConversions) * 100, 1) : 0,
      }))
      .sort((a, b) => b.spend - a.spend);

    const keywords = pd?.byLevel?.keyword || [];
    const activeKeywords = keywords.filter((kw) => {
      const status = String(kw.status || "").toLowerCase();
      return !status.includes("paused") && !status.includes("removed");
    });
    const zeroImpressionKeywords = activeKeywords.filter(
      (kw) => num(kw.impressions) === 0 && num(kw.spend) === 0
    );
    const zeroImpressionSharePct =
      activeKeywords.length > 0
        ? round((zeroImpressionKeywords.length / activeKeywords.length) * 100, 1)
        : null;
    const topSpendType = types[0] || null;
    const keywordCoverage = {
      available: activeKeywords.length > 0,
      activeKeywordsTotal: activeKeywords.length,
      zeroImpressionKeywords: zeroImpressionKeywords.length,
      zeroImpressionSharePct,
    };
    const deadKeywordSignal =
      activeKeywords.length > 0 &&
      zeroImpressionSharePct >= 80 &&
      totalSpend > 0 &&
      topSpendType
        ? {
            available: true,
            zeroImpressionKeywords: zeroImpressionKeywords.length,
            activeKeywordsTotal: activeKeywords.length,
            zeroImpressionSharePct,
            topSpendChannelType: topSpendType.channelType,
            topSpendSharePct: topSpendType.spendSharePct,
            topSpend: topSpendType.spend,
            topSpendFormatted: topSpendType.spendFormatted,
            note:
              "Most active keywords show zero impressions while campaign-level spend exists; the account's traffic is coming from campaign types, not the keyword set.",
          }
        : {
            available: false,
            reason:
              activeKeywords.length === 0
                ? "no_keyword_data"
                : "active_keywords_have_delivery_or_no_campaign_spend",
          };

    return {
      available: true,
      currency,
      totalSpend: round(totalSpend),
      totalSpendFormatted: formatMoney(totalSpend, currency),
      totalConversions,
      types,
      keywordCoverage,
      deadKeywordSignal,
    };
  };

  const checkSignificance = ({ metric, denominator } = {}) =>
    isSignificant({ metric, denominator });

  const getBenchmarkTool = ({ metric, platform, businessType } = {}) => {
    const plat = platform || primaryPlatform(audit);
    const bt = businessType || businessTypeOf(audit);
    const band = getBenchmark(metric, plat, bt);
    return band
      ? { available: true, metric, platform: plat, businessType: bt, band }
      : { available: false, reason: "no_benchmark" };
  };

  // Ranked by leverage (severity → confidence → dollars), NOT raw dollars — a
  // rate-severe CRITICAL on a smaller-spend campaign leads a larger-dollar
  // MEDIUM. `minImpact` still filters on recoverable dollars when supplied.
  const listFindings = ({ minImpact = 0 } = {}) =>
    (audit?.ruleFindings || [])
      .filter((f) => parseImpactDollars(f.estimatedImpact) >= num(minImpact))
      .slice()
      .sort(byLeverageDesc)
      .map((f) => ({
        ruleId: f.ruleId,
        platform: f.platform,
        severity: f.severity,
        category: f.category,
        title: f.title,
        estimatedImpact: f.estimatedImpact,
        estimatedImpactDollars: parseImpactDollars(f.estimatedImpact),
      }));

  return {
    getEvidencePacket,
    decomposeKpi,
    analyzeSegments,
    analyzeCampaignTypes,
    checkSignificance,
    getPeerComparison,
    getMemoryDelta,
    getBenchmark: getBenchmarkTool,
    listFindings,
  };
};

/**
 * Tool schemas for LLM tool-calling. Provider-agnostic JSON Schema; the
 * orchestrator adapts these to the active provider's tool format.
 */
export const TOOL_SCHEMAS = [
  {
    name: "getEvidencePacket",
    description:
      "The full curated deterministic packet: findings, summary, comparison facts, verified numbers. Start here. Contains no raw ad rows.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "decomposeKpi",
    description:
      "Break a headline KPI into its drivers (CPM, CTR, CVR for CPA/CPR; AOV, CVR, CPC for ROAS) and name the dominant driver vs the matched peer. Use to test a root-cause hypothesis.",
    input_schema: {
      type: "object",
      properties: { kpi: { type: "string", enum: ["CPA", "CPR", "ROAS"] } },
      additionalProperties: false,
    },
  },
  {
    name: "analyzeSegments",
    description:
      "Rank a breakdown dimension's segments by wasted spend vs the account baseline. Omit `dimension` to scan all available dimensions and return the worst.",
    input_schema: {
      type: "object",
      properties: { dimension: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "analyzeCampaignTypes",
    description:
      "Break spend, impressions, and conversions down by campaign type (Search, Performance Max, Display, Shopping, Demand Gen, Video). Use to resolve WHERE spend and results actually come from — especially when active keywords show ~0 impressions but the account still spends and converts.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "checkSignificance",
    description:
      "Is a rate estimate trustworthy at this sample size? Use to disconfirm a hypothesis built on thin data.",
    input_schema: {
      type: "object",
      properties: {
        metric: { type: "string", enum: ["ctr", "cvr", "cpa", "cpr", "roas"] },
        denominator: { type: "number" },
      },
      required: ["metric", "denominator"],
      additionalProperties: false,
    },
  },
  {
    name: "getPeerComparison",
    description:
      "Compare this account to the most similar same-org account: metric deltas, the strongest underperformance gap, and a confidence note.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "getMemoryDelta",
    description:
      "Self-over-time deltas vs this account's previous audit, plus resolved/new critical findings.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "getBenchmark",
    description:
      "Industry benchmark band (good/warning/danger) for a metric by platform and business type.",
    input_schema: {
      type: "object",
      properties: {
        metric: { type: "string", enum: ["ctr", "cpm"] },
        platform: { type: "string", enum: ["META", "GOOGLE", "TIKTOK"] },
        businessType: { type: "string" },
      },
      required: ["metric"],
      additionalProperties: false,
    },
  },
  {
    name: "listFindings",
    description:
      "Deterministic findings filtered by minimum dollar impact, ranked by impact. No invented numbers.",
    input_schema: {
      type: "object",
      properties: { minImpact: { type: "number" } },
      additionalProperties: false,
    },
  },
];

/**
 * Dispatch a tool call by name against a tool set. Never throws — tool errors
 * are returned as { error } so the orchestrator can feed them back to the model
 * and enforce the deterministic fallback on repeated failure.
 */
export const runTool = (tools, name, input = {}) => {
  const fn = tools?.[name];
  if (typeof fn !== "function") return { error: `unknown_tool:${name}` };
  try {
    return fn(input);
  } catch (err) {
    return { error: err?.message || String(err) };
  }
};
