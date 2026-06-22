import { describe, it, expect } from "vitest";
import { buildReportDocumentFromAudit } from "./reportDocument.service.js";

/**
 * The per-campaign deep-dive — the consultant-grade spine. A flat findings list
 * says WHAT is wrong; this shows every campaign's numbers and a one-line verdict
 * against the account baseline, which is what reads as expert review.
 */
const auditWithCampaigns = (campaigns) => ({
  id: "aud_dd",
  selectedPlatforms: ["META"],
  dataSource: "OAUTH",
  healthScore: 70,
  categoryScores: { overall: 70 },
  businessProfileSnapshot: { sectionA: { businessType: "Lead Gen", currency: "PKR" } },
  ruleFindings: [
    { ruleId: "CAMP-CPA-001", platform: "META", severity: "CRITICAL", title: "x", detail: "x", estimatedImpact: "PKR 1,000 recoverable", evidence: { level: "campaign" } },
  ],
  normalizedDataset: {
    summary: {
      totals: { spend: 12427, conversions: 183, currency: "PKR" },
      platforms: { META: { spend: 12427, conversions: 183, clicks: 411, impressions: 39578, currency: "PKR" } },
    },
    data: {
      platforms: {
        META: {
          records: campaigns,
          byLevel: { campaign: campaigns },
          byDimension: {},
          byDay: [],
          currency: "PKR",
        },
      },
    },
  },
});

const campaigns = [
  { level: "campaign", name: "New Engagement Campaign", status: "PAUSED", spend: 7089, results: 161 },
  { level: "campaign", name: "Pesh | WA | 23/5", status: "PAUSED", spend: 2928, results: 22 },
  { level: "campaign", name: "Kingdom Testing", status: "PAUSED", spend: 1661, results: 0 },
];

describe("per-campaign deep-dive section", () => {
  const doc = buildReportDocumentFromAudit(auditWithCampaigns(campaigns));
  const section = doc.sections.find((s) => s.id === "campaign-deep-dive");

  it("renders a section with one row per campaign", () => {
    expect(section).toBeDefined();
    const table = section.blocks[0];
    expect(table.type).toBe("data_table");
    expect(table.rows).toHaveLength(3);
  });

  it("assigns the right verdict to each campaign vs the PKR 68 baseline", () => {
    // Columns: Campaign | Spend | Results | Cost/result | Status | Verdict.
    const byName = Object.fromEntries(section.blocks[0].rows.map((r) => [r[0], r[5]]));
    // New Engagement: PKR 44 cost/result, below baseline → protect & scale.
    expect(byName["New Engagement Campaign"]).toMatch(/protect and scale/i);
    // Pesh: PKR 133, ~2× baseline → above average, tighten.
    expect(byName["Pesh | WA | 23/5"]).toMatch(/above the account average/i);
    // Kingdom: material spend, zero conversions → misconfiguration.
    expect(byName["Kingdom Testing"]).toMatch(/zero conversions/i);
  });

  it("gives each campaign an at-a-glance status pill", () => {
    const statusByName = Object.fromEntries(section.blocks[0].rows.map((r) => [r[0], r[4]]));
    // New Engagement at/below baseline → good; Kingdom zero-conv → bad.
    expect(statusByName["New Engagement Campaign"].status).toBe("good");
    expect(statusByName["Kingdom Testing"].status).toBe("bad");
  });

  it("does not render for a single-campaign account", () => {
    const single = buildReportDocumentFromAudit(
      auditWithCampaigns([{ level: "campaign", name: "Only", status: "ACTIVE", spend: 5000, results: 100 }])
    );
    expect(single.sections.find((s) => s.id === "campaign-deep-dive")).toBeUndefined();
  });
});
