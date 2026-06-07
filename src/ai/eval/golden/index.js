/**
 * Golden eval fixtures.
 *
 * Each fixture provides:
 *   - audit            an audit-like object (buildAiAuditContext / buildEvidencePacket consume it)
 *   - priorAudits      stored memory summaries (for peer/memory cases)
 *   - expected         requiredRuleIds, requiredDollars, themes, forbiddenNumbers
 *   - referenceOutput  a strategist-quality AI output used to score the rubric
 *                      DETERMINISTICALLY (no AI call). In --live mode the runner
 *                      ignores this and scores the real provider response.
 *
 * Keep these realistic but anonymized — no real customer data.
 */

const baseAudit = (over = {}) => ({
  id: over.id || "eval-audit",
  adAccountId: over.adAccountId || "ACC-1",
  adAccount: { name: over.adAccountName || "Sample Account" },
  completedAt: "2026-06-01",
  selectedPlatforms: over.selectedPlatforms || ["GOOGLE"],
  dataSource: "MANUAL_UPLOAD",
  healthScore: over.healthScore ?? 62,
  categoryScores: {},
  uploadReadiness: { mode: "FULL" },
  businessProfileSnapshot: {
    sectionA: { businessType: "eCommerce", targetCpa: 50, monthlyBudget: 10000, ...(over.sectionA || {}) },
  },
  intakeResponses: [{ section: "PLATFORM_GOOGLE", answers: {} }],
  normalizedDataset: {
    summary: {
      totals: over.totals || { spend: 10000, impressions: 500000, clicks: 8000, conversions: 120 },
      platforms: over.platforms || { GOOGLE: { spend: 10000, impressions: 500000, clicks: 8000, conversions: 120, currency: "USD" } },
    },
    data: { platforms: { GOOGLE: { records: [{ level: "campaign", name: "C1", spend: 10000 }], byLevel: {}, byDimension: {}, byDay: [] } } },
  },
  ruleFindings: over.ruleFindings || [],
  aiReport: null,
});

const fixtures = [
  // 1) Google search-term waste
  {
    name: "google-search-term-waste",
    audit: baseAudit({
      ruleFindings: [
        {
          ruleId: "GOOGLE-SEARCH-TERM-WASTE-001",
          platform: "GOOGLE",
          severity: "CRITICAL",
          category: "Keyword Strategy",
          title: "$20,566 of Google search-term spend produced zero conversions",
          detail: "419 terms wasted $20,566.",
          evidence: { wastedSpend: 20566, wastedTermCount: 419 },
          estimatedImpact: "$20,566 in identified waste. Acting on this typically recovers 80% ($16,453) within 2 weeks.",
          fixSteps: ["Add negatives"],
        },
      ],
    }),
    priorAudits: [],
    expected: {
      requiredRuleIds: ["GOOGLE-SEARCH-TERM-WASTE-001"],
      requiredDollars: [20566],
      themes: ["waste"],
      forbiddenNumbers: [99999, 12345],
    },
    referenceOutput: {
      executiveSummary: [
        "Your account scores 62/100 across $10,000 reviewed. The single biggest leak: $20,566 of Google search-term spend produced zero conversions.",
        "That $20,566 is direct, recoverable waste — adding negative keywords typically recovers about 80% ($16,453) within two weeks.",
      ],
      topPriorities: [
        { ruleId: "GOOGLE-SEARCH-TERM-WASTE-001", platform: "GOOGLE", severity: "CRITICAL", title: "Search-term waste", estimatedImpact: "$20,566 wasted on zero-conversion terms", recommendedAction: "Add the 419 zero-conversion terms as negative keywords" },
      ],
      quickWins: [{ ruleId: "GOOGLE-SEARCH-TERM-WASTE-001", platform: "GOOGLE", title: "Export and negate wasted terms", fixSteps: ["Export the search-terms report", "Add zero-conversion terms as negatives"] }],
      confidenceNotes: ["Sufficient click volume on the flagged terms for a confident verdict."],
      clientReadyRecommendations: [
        { headline: "Cut $20,566 of zero-conversion search spend", explanation: "419 search terms consumed $20,566 with zero conversions. This is direct, recoverable waste — about $16,453 is reclaimable.", nextSteps: ["Export the search-terms report", "Add the terms as campaign-level negatives"], sourceRuleIds: ["GOOGLE-SEARCH-TERM-WASTE-001"] },
      ],
    },
  },

  // 2) Meta segment waste
  {
    name: "meta-segment-waste",
    audit: baseAudit({
      selectedPlatforms: ["META"],
      adAccountId: "ACC-META",
      platforms: { META: { spend: 1510, impressions: 100000, clicks: 1080, conversions: 47, currency: "USD" } },
      totals: { spend: 1510, impressions: 100000, clicks: 1080, conversions: 47 },
      ruleFindings: [
        {
          ruleId: "SEG-WASTE-001",
          platform: "META",
          severity: "MEDIUM",
          category: "Audience Strategy",
          title: "The 45-54 age segment is wasting $206",
          detail: "The 45-54 age segment spent $206 with zero conversions vs a $32 baseline CPA.",
          evidence: { dimension: "age", segment: "45-54", estimatedWaste: 206, baselineCpa: 32, reason: "zero_conversions", confidence: "high" },
          estimatedImpact: "$206 in this segment is recoverable by excluding it.",
          fixSteps: ["Exclude the 45-54 segment"],
        },
      ],
    }),
    priorAudits: [],
    expected: {
      requiredRuleIds: ["SEG-WASTE-001"],
      requiredDollars: [206],
      themes: ["segment", "waste"],
      forbiddenNumbers: [5000],
    },
    referenceOutput: {
      executiveSummary: [
        "Health score 62/100 over $1,510 of Meta spend. The clearest waste is segment-level: the 45-54 age bracket spent $206 with zero conversions.",
        "Excluding the 45-54 segment recovers $206 and reallocates it to brackets performing at the $32 baseline CPA.",
      ],
      topPriorities: [
        { ruleId: "SEG-WASTE-001", platform: "META", severity: "MEDIUM", title: "45-54 segment waste", estimatedImpact: "$206 wasted in the 45-54 age segment", recommendedAction: "Exclude the 45-54 age segment from active ad sets" },
      ],
      quickWins: [{ ruleId: "SEG-WASTE-001", platform: "META", title: "Exclude underperforming age segment", fixSteps: ["Add a 45-54 age exclusion"] }],
      confidenceNotes: ["Segment verdict has sufficient sample (high confidence)."],
      clientReadyRecommendations: [
        { headline: "Stop spending on the 45-54 segment", explanation: "The 45-54 age segment spent $206 with zero conversions against a $32 baseline CPA. Excluding it recovers that spend.", nextSteps: ["Exclude 45-54 in ad set targeting", "Reallocate to 18-34"], sourceRuleIds: ["SEG-WASTE-001"] },
      ],
      segmentInsights: ["The 45-54 age segment wasted $206 with zero conversions."],
    },
  },

  // 3) CPA diagnostic (decomposition)
  {
    name: "cpa-diagnostic",
    audit: baseAudit({
      selectedPlatforms: ["META"],
      adAccountId: "ACC-CPA",
      platforms: { META: { spend: 2000, impressions: 100000, clicks: 2000, conversions: 20, currency: "USD" } },
      totals: { spend: 2000, impressions: 100000, clicks: 2000, conversions: 20 },
      ruleFindings: [
        {
          ruleId: "DIAG-CPA-001",
          platform: "META",
          severity: "HIGH",
          category: "Bidding & Budget",
          title: "Meta CPA is over target — driven by weak post-click conversion, not expensive clicks",
          detail: "Actual CPA $100 vs target $50 (100% over). CTR 2% is at/above benchmark — the bottleneck is post-click conversion.",
          evidence: { metric: "CPA", actualCpa: 100, targetCpa: 50, dominantDriver: "conversion_rate", confidence: "high" },
          estimatedImpact: "CPA is 100% over your $50 target. Because CTR is healthy, fix landing page / offer / tracking, not bids.",
          fixSteps: ["Audit the landing page"],
        },
      ],
    }),
    priorAudits: [],
    expected: {
      requiredRuleIds: ["DIAG-CPA-001"],
      requiredDollars: [100, 50],
      // CPA diagnostics aren't a tracking/waste/segment/peer/memory theme —
      // no theme requirement here (the rubric scores themeCoverage=1 when empty).
      themes: [],
      forbiddenNumbers: [777],
    },
    referenceOutput: {
      executiveSummary: [
        "Health score 62/100 over $2,000 of Meta spend. CPA is $100 — double your declared $50 target.",
        "The driver is post-click conversion, not click cost: CTR is healthy at 2%, so the fix is landing page, offer, and tracking — not bids.",
      ],
      topPriorities: [
        { ruleId: "DIAG-CPA-001", platform: "META", severity: "HIGH", title: "CPA 2x over target — conversion-driven", estimatedImpact: "$100 CPA vs $50 target (100% over)", recommendedAction: "Audit the landing page and conversion tracking before changing bids" },
      ],
      quickWins: [{ ruleId: "DIAG-CPA-001", platform: "META", title: "Verify conversion tracking", fixSteps: ["Confirm the purchase event fires"] }],
      confidenceNotes: ["High confidence — sufficient conversion sample."],
      clientReadyRecommendations: [
        { headline: "Fix post-click conversion, not bids", explanation: "CPA is $100 vs your $50 target. CTR is healthy, so the bottleneck is after the click — landing page, offer, or tracking.", nextSteps: ["Audit landing page speed + message match", "Verify conversion tracking"], sourceRuleIds: ["DIAG-CPA-001"] },
      ],
    },
  },

  // 4) Peer CTR gap (requires prior peer summary)
  {
    name: "peer-ctr-gap",
    audit: baseAudit({
      selectedPlatforms: ["GOOGLE"],
      adAccountId: "ACC-WEAK",
      adAccountName: "Brand A",
      platforms: { GOOGLE: { spend: 5000, impressions: 100000, clicks: 1000, conversions: 50, currency: "USD" } },
      totals: { spend: 5000, impressions: 100000, clicks: 1000, conversions: 50 },
      ruleFindings: [
        {
          ruleId: "PEER-CTR-001",
          platform: "GOOGLE",
          severity: "HIGH",
          category: "Quality Score & Relevance",
          title: "Google CTR is 75% below a similar account in your portfolio",
          detail: "This account's CTR (1.0%) is far below Brand B (4.0%) at the same spend band.",
          evidence: { currentCtr: 1, peerCtr: 4, ctrGapPct: 75, peerAccount: "Brand B", confidence: "high" },
          estimatedImpact: "Closing the CTR gap to Brand B (4.0%) lowers CPC and CPA at the same spend.",
          fixSteps: ["Adapt Brand B's top creatives"],
        },
      ],
    }),
    priorAudits: [
      {
        auditId: "peer-prev", adAccountId: "ACC-STRONG", adAccountName: "Brand B",
        completedAt: "2026-05-15", selectedPlatforms: ["GOOGLE"], businessType: "eCommerce",
        spend: 5000, impressions: 100000, clicks: 4000, conversions: 100, healthScore: 85,
        kpis: { ctr: 4, cpc: 1.25, cpa: 50, cpm: 50, roas: null }, criticalRuleIds: [], schemaVersion: 3,
      },
    ],
    expected: {
      requiredRuleIds: ["PEER-CTR-001"],
      requiredDollars: [],
      themes: ["peer"],
      forbiddenNumbers: [88888],
    },
    referenceOutput: {
      executiveSummary: [
        "Health score 62/100. The standout issue is relative: this account's CTR (1.0%) is 75% below your own Brand B account (4.0%) at the same spend band.",
        "Same platform, comparable profile — the gap points to creative relevance, not platform pricing. Brand B is the template to copy.",
      ],
      topPriorities: [
        { ruleId: "PEER-CTR-001", platform: "GOOGLE", severity: "HIGH", title: "CTR 75% below your best account", estimatedImpact: "CTR 1.0% vs Brand B 4.0% (75% gap)", recommendedAction: "Adapt Brand B's top-performing creative hooks to this account" },
      ],
      quickWins: [{ ruleId: "PEER-CTR-001", platform: "GOOGLE", title: "Borrow winning creative", fixSteps: ["Pull Brand B top ads", "Adapt the hook"] }],
      confidenceNotes: ["Both accounts have sufficient impression volume for a confident comparison."],
      clientReadyRecommendations: [
        { headline: "Copy what works in Brand B", explanation: "This account's CTR (1.0%) is 75% below your Brand B account (4.0%) at the same spend band. The gap is creative, not pricing.", nextSteps: ["Audit Brand B's top creatives", "A/B test adapted versions here"], sourceRuleIds: ["PEER-CTR-001"] },
      ],
      comparisonInsights: ["CTR (1.0%) is 75% below your Brand B account (4.0%) at the same spend band."],
    },
  },

  // 5) Memory regression (requires prior same-account summary)
  {
    name: "memory-regression",
    audit: baseAudit({
      selectedPlatforms: ["META"],
      adAccountId: "ACC-REG",
      adAccountName: "Brand C",
      platforms: { META: { spend: 5000, impressions: 100000, clicks: 4000, conversions: 50, currency: "USD" } },
      totals: { spend: 5000, impressions: 100000, clicks: 4000, conversions: 50 },
      healthScore: 58,
      ruleFindings: [
        {
          ruleId: "MEMORY-REGRESSION-001",
          platform: "META",
          severity: "HIGH",
          category: "Attribution & Reporting",
          title: "Meta CPA worsened 100% since your last audit",
          detail: "CPA moved from $50 to $100 (100% worse) since the 2026-05-01 audit.",
          evidence: { previousCpa: 50, currentCpa: 100, cpaDeltaPct: 100, previousCompletedAt: "2026-05-01", confidence: "high" },
          estimatedImpact: "CPA is up 100% vs your prior audit. Reverting recent changes or re-checking tracking is the fastest path back.",
          fixSteps: ["Compare what changed since the last audit"],
        },
      ],
    }),
    priorAudits: [
      {
        auditId: "mem-prev", adAccountId: "ACC-REG", adAccountName: "Brand C",
        completedAt: "2026-05-01", selectedPlatforms: ["META"], businessType: "eCommerce",
        spend: 5000, impressions: 100000, clicks: 4000, conversions: 100, healthScore: 72,
        kpis: { ctr: 4, cpc: 1.25, cpa: 50, cpm: 50, roas: null }, criticalRuleIds: [], schemaVersion: 3,
      },
    ],
    expected: {
      requiredRuleIds: ["MEMORY-REGRESSION-001"],
      requiredDollars: [50, 100],
      themes: ["memory"],
      forbiddenNumbers: [4242],
    },
    referenceOutput: {
      executiveSummary: [
        "Health score 58/100, down from 72 in your 2026-05-01 audit. CPA worsened 100% — from $50 to $100 — since then.",
        "A sudden CPA doubling is often a tracking break or a recent change. Audit what changed since 2026-05-01 first.",
      ],
      topPriorities: [
        { ruleId: "MEMORY-REGRESSION-001", platform: "META", severity: "HIGH", title: "CPA doubled since last audit", estimatedImpact: "CPA $50 to $100 (100% worse) since 2026-05-01", recommendedAction: "Compare budget, targeting, creative and tracking changes since 2026-05-01" },
      ],
      quickWins: [{ ruleId: "MEMORY-REGRESSION-001", platform: "META", title: "Rule out a tracking break", fixSteps: ["Check Events Manager for the period"] }],
      confidenceNotes: ["Sufficient conversion sample in the current window."],
      clientReadyRecommendations: [
        { headline: "Investigate the CPA regression since May 1", explanation: "CPA rose from $50 to $100 (100% worse) since your 2026-05-01 audit. Often this is under-attribution from a tracking break, not real performance loss.", nextSteps: ["Diff changes since 2026-05-01", "Verify conversion tracking"], sourceRuleIds: ["MEMORY-REGRESSION-001"] },
      ],
      memoryInsights: ["CPA worsened 100% (from $50 to $100) since your 2026-05-01 audit."],
    },
  },
];

export default fixtures;
