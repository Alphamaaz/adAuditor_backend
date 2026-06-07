/**
 * Deep Audit — golden eval fixtures. (spec: docs/DEEP_AUDIT_SPEC.md → Eval requirements)
 *
 * Each fixture is a MULTI-HYPOTHESIS case: a naive read of the headline KPI
 * could blame the wrong driver. The correct root cause is only visible after
 * decomposing / comparing — exactly what the agentic loop must do. Every
 * fixture is annotated with:
 *   - `signal`: the deterministic tool + expected result (CI-asserted in
 *     fixtures.test.js — proves the substrate the agent reasons over is correct)
 *   - `keywords`: terms the live conclusion must mention to count as "reached
 *     the right root cause" (scored by run.js in live mode)
 *
 * Numbers are internally consistent so the deterministic tools land on the
 * stated driver (verified in fixtures.test.js).
 */

const META = ["META"];

const currentAudit = ({
  id,
  adAccountId,
  name,
  spend,
  impressions,
  clicks,
  conversions,
  businessType = "Lead Gen",
  targetCpa = 20,
  byDimension = {},
  findings = [],
}) => ({
  id,
  organizationId: "org_eval",
  adAccountId,
  adAccount: { name },
  selectedPlatforms: META,
  healthScore: 62,
  completedAt: "2026-06-03T00:00:00Z",
  dataSource: "OAUTH",
  businessProfileSnapshot: { sectionA: { businessType, targetCpa } },
  normalizedDataset: {
    summary: { totals: { spend, impressions, clicks, conversions } },
    data: { platforms: { META: { byDimension } } },
  },
  intakeResponses: [],
  ruleFindings: findings,
});

// A stored memory summary for a same-org peer account (shape consumed by
// normalizeSnapshotFromMemory).
const peer = ({
  id,
  adAccountId,
  name,
  spend,
  impressions,
  clicks,
  conversions,
  businessType = "Lead Gen",
}) => ({
  auditId: id,
  adAccountId,
  adAccountName: name,
  selectedPlatforms: META,
  businessType,
  completedAt: "2026-06-01T00:00:00Z",
  spend,
  impressions,
  clicks,
  conversions,
  healthScore: 80,
  criticalRuleIds: [],
});

export const DEEP_AUDIT_FIXTURES = [
  {
    name: "ctr-not-cpm",
    description:
      "Same CPM as a better peer, but ~2.4x worse CTR → the lever is creative clickability, not impression price (the live Essa-vs-Umeed case).",
    kpi: "CPR",
    audit: currentAudit({
      id: "fx_ctr",
      adAccountId: "acc_essa",
      name: "Essa Trader",
      spend: 2019,
      impressions: 51000,
      clicks: 2020,
      conversions: 64,
      findings: [
        { ruleId: "BENCH-CTR-001", platform: "META", severity: "MEDIUM", category: "Creative Performance", title: "CTR below benchmark", estimatedImpact: "$0" },
        { ruleId: "CRE-003", platform: "META", severity: "HIGH", category: "Creative Performance", title: "Below-average ranked ads", estimatedImpact: "$1,200 in spend on below-average ranked ads" },
      ],
    }),
    priorAudits: [
      peer({ id: "fx_umeed", adAccountId: "acc_umeed", name: "Umeed Marketing", spend: 2000, impressions: 50000, clicks: 4800, conversions: 150 }),
    ],
    signal: { tool: "decomposeKpi", dominantDriver: "CTR" },
    keywords: ["ctr", "click", "creative"],
  },
  {
    name: "cpm-driven",
    description:
      "CTR and CVR match the peer, but CPM is 4x higher → the cost-per-result gap is impression price, not creative or funnel.",
    kpi: "CPA",
    audit: currentAudit({
      id: "fx_cpm",
      adAccountId: "acc_cpm",
      name: "HighCPM Co",
      spend: 8000,
      impressions: 100000,
      clicks: 5000,
      conversions: 200,
      findings: [
        { ruleId: "BENCH-CPM-001", platform: "META", severity: "HIGH", category: "Bidding & Budget", title: "CPM above benchmark", estimatedImpact: "$3,000 in elevated CPM" },
      ],
    }),
    priorAudits: [
      peer({ id: "fx_cpm_peer", adAccountId: "acc_cpm_peer", name: "Efficient Co", spend: 2000, impressions: 100000, clicks: 5000, conversions: 200 }),
    ],
    signal: { tool: "decomposeKpi", dominantDriver: "CPM" },
    keywords: ["cpm", "impression"],
  },
  {
    name: "cvr-post-click",
    description:
      "CPM and CTR match the peer, but conversion rate is 2.5x worse → the bottleneck is post-click (landing page / offer / tracking), not media.",
    kpi: "CPA",
    audit: currentAudit({
      id: "fx_cvr",
      adAccountId: "acc_cvr",
      name: "LeakyFunnel Co",
      spend: 4000,
      impressions: 100000,
      clicks: 5000,
      conversions: 100,
      findings: [
        { ruleId: "DIAG-CPA-001", platform: "META", severity: "HIGH", category: "Attribution & Reporting", title: "CPA over target, CTR healthy", estimatedImpact: "$2,000 in lost efficiency" },
      ],
    }),
    priorAudits: [
      peer({ id: "fx_cvr_peer", adAccountId: "acc_cvr_peer", name: "TightFunnel Co", spend: 4000, impressions: 100000, clicks: 5000, conversions: 250 }),
    ],
    signal: { tool: "decomposeKpi", dominantDriver: "CVR" },
    keywords: ["conversion rate", "cvr", "landing", "post-click", "convert", "funnel"],
  },
  {
    name: "segment-waste",
    description:
      "Blended CPR looks acceptable, but one age bracket burns budget at zero conversions → the fix is audience trimming, not creative.",
    kpi: "CPR",
    audit: currentAudit({
      id: "fx_seg",
      adAccountId: "acc_seg",
      name: "BroadAudience Co",
      spend: 2019,
      impressions: 51000,
      clicks: 2020,
      conversions: 64,
      byDimension: {
        age: [
          { dimension: "age", segment: "25-34", spend: 729, clicks: 500, impressions: 20000, conversions: 25, results: 25 },
          { dimension: "age", segment: "45-54", spend: 206, clicks: 180, impressions: 12000, conversions: 0, results: 0 },
        ],
      },
      findings: [
        { ruleId: "SEG-WASTE-001", platform: "META", severity: "MEDIUM", category: "Audience Strategy", title: "Age 45-54 waste", estimatedImpact: "$206 wasted on the 45-54 bracket" },
      ],
    }),
    priorAudits: [],
    signal: { tool: "analyzeSegments", segment: "45-54" },
    keywords: ["45-54", "age", "segment", "audience", "bracket"],
  },
];
