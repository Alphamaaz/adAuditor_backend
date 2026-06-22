import { describe, it, expect } from "vitest";
import { buildReportDocumentFromAudit } from "./reportDocument.service.js";
import { renderBlock, renderReport } from "./premiumReportRenderer.service.js";

/**
 * The account scorecard — the "show your proof" element the client asked for:
 * every headline metric anchored to a benchmark/target with a pass/watch/fail
 * verdict, the way the reference Claude audit presents its data.
 */
const audit = {
  id: "aud_sc",
  selectedPlatforms: ["GOOGLE"],
  healthScore: 74,
  businessProfileSnapshot: { sectionA: { businessType: "Lead Gen", currency: "PKR", targetCpa: 80 } },
  normalizedDataset: {
    summary: {
      totals: { spend: 89658, impressions: 433215, clicks: 28452, conversions: 649, currency: "PKR" },
      platforms: { GOOGLE: { spend: 89658, impressions: 433215, clicks: 28452, conversions: 649, currency: "PKR" } },
    },
    data: {
      platforms: {
        GOOGLE: {
          records: [
            { level: "campaign", name: "Display | PK | Signals", status: "ACTIVE", spend: 9839, results: 8, cpa: 1230, clicks: 2859 },
            { level: "campaign", name: "Display | BD | Signals", status: "ACTIVE", spend: 23219, results: 271, cpa: 86, clicks: 6649 },
          ],
          byLevel: {
            campaign: [
              { level: "campaign", name: "Display | PK | Signals", status: "ACTIVE", spend: 9839, results: 8, cpa: 1230, clicks: 2859 },
              { level: "campaign", name: "Display | BD | Signals", status: "ACTIVE", spend: 23219, results: 271, cpa: 86, clicks: 6649 },
            ],
          },
          byDimension: {},
          byDay: [],
          currency: "PKR",
        },
      },
    },
  },
  ruleFindings: [
    { ruleId: "CAMP-CPA-001", platform: "GOOGLE", severity: "CRITICAL", title: "CPA varies by campaign", detail: "x", estimatedImpact: "PKR 11,693 is recoverable", evidence: { level: "campaign", confidence: "high", worstEntity: "Display | PK | Signals" } },
  ],
};

describe("account scorecard", () => {
  const doc = buildReportDocumentFromAudit(audit);
  const section = doc.sections.find((s) => s.id === "scorecard");
  const rows = section?.blocks?.[0]?.rows || [];
  const byMetric = (name) => rows.find((r) => r.metric === name);

  it("renders a scorecard section anchored to benchmarks/targets", () => {
    expect(section).toBeDefined();
    expect(section.blocks[0].type).toBe("scorecard");
  });

  it("flags CPA over the declared target as off-target (red) with the % over", () => {
    const cpa = byMetric("Cost per acquisition");
    expect(cpa).toBeDefined();
    expect(cpa.target).toBe("PKR 80");
    expect(cpa.status).toBe("bad"); // 138 vs 80 → ~73% over
    expect(cpa.statusLabel).toMatch(/over target/);
  });

  it("passes a strong CTR against its industry benchmark (green)", () => {
    const ctr = byMetric("Click-through rate");
    expect(ctr).toBeDefined();
    expect(ctr.status).toBe("good");
  });

  it("renders status pills in the HTML (proof verdicts, not flat cells)", () => {
    const html = renderBlock(section.blocks[0]);
    expect(html).toContain("status-bad"); // CPA off target
    expect(html).toContain("status-good"); // CTR strong
  });

  it("gives each campaign an at-a-glance status pill in the deep-dive", () => {
    const deep = doc.sections.find((s) => s.id === "campaign-deep-dive");
    expect(deep).toBeDefined();
    const html = renderBlock(deep.blocks[0]);
    // PK runs ~8.9x baseline → off target; BD at/below avg → on target.
    expect(html).toContain("status-bad");
    expect(html).toContain("status-good");
  });
});

describe("per-finding proof tables", () => {
  const auditWith = (finding) => ({
    id: "aud_proof",
    selectedPlatforms: ["GOOGLE"],
    healthScore: 70,
    businessProfileSnapshot: { sectionA: { businessType: "Lead Gen", currency: "PKR" } },
    normalizedDataset: {
      summary: { totals: { spend: 50000, conversions: 400, currency: "PKR" }, platforms: { GOOGLE: { spend: 50000, conversions: 400, currency: "PKR" } } },
      data: { platforms: { GOOGLE: { records: [], byLevel: { campaign: [] }, byDimension: {}, byDay: [], currency: "PKR" } } },
    },
    ruleFindings: [finding],
  });

  const proofBlockOf = (doc) => {
    const detail = doc.sections.find((s) => s.id === "finding-detail");
    const finding = detail.blocks[0];
    return finding.body_blocks.find((b) => b.type === "scorecard");
  };

  it("renders a benchmarked proof table when the finding pairs a metric with a reference", () => {
    const doc = buildReportDocumentFromAudit(
      auditWith({
        ruleId: "GOOGLE-BID-002", platform: "GOOGLE", severity: "MEDIUM",
        title: "Campaign is missing its Target CPA", detail: "x",
        estimatedImpact: "Closing the gap brings cost back in line.",
        evidence: { actualCpa: 200, targetCpa: 100, confidence: "high" },
      })
    );
    const proof = proofBlockOf(doc);
    expect(proof).toBeDefined();
    const cpa = proof.rows.find((r) => r.metric === "Cost per acquisition");
    expect(cpa.value).toBe("PKR 200");
    expect(cpa.target).toBe("vs PKR 100");
    expect(cpa.status).toBe("bad"); // 2x the target
    // HTML shows the verdict pill, proving the claim visually.
    expect(renderBlock(proof)).toContain("status-bad");
  });

  it("treats a diagnostic finding as Optimization — no phantom recoverable money", () => {
    const doc = buildReportDocumentFromAudit(
      auditWith({
        ruleId: "DIAG-CPA-001", platform: "GOOGLE", severity: "HIGH",
        title: "Google CPA is over target — driven by weak post-click conversion",
        detail: "Actual CPA PKR 138 vs target PKR 40.",
        // Narrative references "PKR 40" (the TARGET) — must NOT be parsed as recovered money.
        estimatedImpact: "CPA is 245% over your PKR 40 target. The highest-leverage fix is post-click.",
        evidence: { diagnostic: true, actualCpa: 138, targetCpa: 40, confidence: "high" },
      })
    );
    // Findings table shows "Optimization", not "PKR 40 recoverable".
    const row = doc.sections.find((s) => s.id === "findings").blocks[0].rows.find((r) => /over target/i.test(r[1]));
    expect(row[3]).toBe("Optimization");
    // It never reaches the money map (no recoverable dollar).
    expect(doc.sections.find((s) => s.id === "money-map")).toBeUndefined();
    // The proof table still proves the claim (CPA vs target) but adds no recoverable row.
    const proof = doc.sections.find((s) => s.id === "finding-detail").blocks[0].body_blocks.find((b) => b.type === "scorecard");
    expect(proof.rows.find((r) => r.metric === "Cost per acquisition").status).toBe("bad");
    expect(proof.rows.find((r) => r.metric === "Recoverable spend")).toBeUndefined();
  });

  it("falls back to the plain evidence table when there is no benchmark pair", () => {
    const doc = buildReportDocumentFromAudit(
      auditWith({
        ruleId: "GOOGLE-NAMING-001", platform: "GOOGLE", severity: "LOW",
        title: "Naming inconsistency", detail: "x",
        estimatedImpact: "Account hygiene risk.",
        evidence: { affectedCampaigns: 12, confidence: "high" },
      })
    );
    const detail = doc.sections.find((s) => s.id === "finding-detail");
    const blocks = detail.blocks[0].body_blocks;
    expect(blocks.find((b) => b.type === "scorecard")).toBeUndefined();
    expect(blocks.find((b) => b.type === "evidence_table")).toBeDefined();
  });
});

describe("phased roadmap", () => {
  const doc = buildReportDocumentFromAudit({
    id: "aud_rm",
    selectedPlatforms: ["GOOGLE"],
    healthScore: 65,
    businessProfileSnapshot: { sectionA: { businessType: "Lead Gen", currency: "PKR" } },
    normalizedDataset: {
      summary: { totals: { spend: 50000, conversions: 300, currency: "PKR" }, platforms: { GOOGLE: { spend: 50000, conversions: 300, currency: "PKR" } } },
      data: { platforms: { GOOGLE: { records: [], byLevel: { campaign: [] }, byDimension: {}, byDay: [], currency: "PKR" } } },
    },
    ruleFindings: [
      { ruleId: "CAMP-CPA-001", platform: "GOOGLE", severity: "CRITICAL", title: "Campaign burning spend", detail: "x", estimatedImpact: "PKR 9,000 is recoverable", fixSteps: ["Fix the campaign."], evidence: { confidence: "high" } },
      { ruleId: "SEG-WASTE-001", platform: "GOOGLE", severity: "MEDIUM", title: "Segment waste", detail: "x", estimatedImpact: "PKR 2,000 is recoverable", fixSteps: ["Trim the segment."], evidence: { confidence: "high" } },
      { ruleId: "GOOGLE-NAMING-001", platform: "GOOGLE", severity: "LOW", title: "Naming inconsistency", detail: "x", estimatedImpact: "Account hygiene risk.", fixSteps: ["Rename."], evidence: {} },
    ],
  });
  const section = doc.sections.find((s) => s.id === "roadmap");

  it("renders a 3-phase roadmap sequenced by leverage", () => {
    expect(section).toBeDefined();
    const phases = section.blocks[0].phases;
    expect(phases).toHaveLength(3);
    expect(phases[0].label).toBe("Phase 1");
    // Phase 1 (this week) leads with the CRITICAL waste.
    expect(phases[0].items[0].action).toMatch(/burning spend/i);
    // Phase 3 catches the structural/hygiene low.
    expect(phases[2].items[0].action).toMatch(/naming/i);
  });

  it("carries an effort hint on each item (absorbed from the old action plan)", () => {
    expect(section.blocks[0].phases[0].items[0].effort).toBeTruthy();
  });

  it("renders the roadmap but no separate Action Plan section (merged)", () => {
    const html = renderReport(doc);
    expect(html).toContain("phase-no"); // roadmap rendered
    // The standalone week-one action-plan section is gone (merged into roadmap).
    expect(html).not.toContain(">Action plan<");
  });
});

describe("per-campaign deep-dive cards", () => {
  const campaigns = [
    { level: "campaign", name: "Display | PK", status: "ACTIVE", spend: 9839, results: 8, cpa: 1230, clicks: 2859, impressions: 41699 },
    { level: "campaign", name: "Display | BD", status: "ACTIVE", spend: 23219, results: 271, cpa: 86, clicks: 6649, impressions: 100831 },
  ];
  const doc = buildReportDocumentFromAudit({
    id: "aud_cards",
    selectedPlatforms: ["GOOGLE"],
    healthScore: 70,
    businessProfileSnapshot: { sectionA: { businessType: "Lead Gen", currency: "PKR", targetCpa: 80 } },
    normalizedDataset: {
      summary: { totals: { spend: 33058, conversions: 279, currency: "PKR" }, platforms: { GOOGLE: { spend: 33058, conversions: 279, currency: "PKR" } } },
      data: { platforms: { GOOGLE: { records: campaigns, byLevel: { campaign: campaigns }, byDimension: {}, byDay: [], currency: "PKR" } } },
    },
    ruleFindings: [{ ruleId: "CAMP-CPA-001", platform: "GOOGLE", severity: "CRITICAL", title: "x", detail: "x", estimatedImpact: "PKR 1,000 recoverable", evidence: { level: "campaign" } }],
  });
  const section = doc.sections.find((s) => s.id === "campaign-cards");

  it("renders a scored card per top campaign with CTR/CPA benchmarks", () => {
    expect(section).toBeDefined();
    const cards = section.blocks.filter((b) => b.type === "campaign_card");
    expect(cards.length).toBeGreaterThanOrEqual(2);
    const pk = cards.find((c) => c.name.includes("PK"));
    const cpaRow = pk.metrics.find((m) => m.metric === "Cost per result");
    expect(cpaRow.status).toBe("bad"); // PK CPA 1230 vs target 80
    expect(pk.steps.length).toBeGreaterThan(0);
  });

  it("marks the efficient campaign on target and gives it scaling steps", () => {
    const cards = section.blocks.filter((b) => b.type === "campaign_card");
    const bd = cards.find((c) => c.name.includes("BD"));
    expect(bd.status).toBe("good"); // BD CPA 86 ≈ baseline
    expect(bd.steps.join(" ")).toMatch(/scale|protect/i);
  });
});
