import { describe, it, expect } from "vitest";
import { buildReportDocumentFromAudit } from "./reportDocument.service.js";

// A secondary "lens" finding (net PKR 0) sorted ahead of the real primary, plus
// the primary that carries the recoverable dollar. Reproduces the page-1 bug
// where the cover led with the net-0 placement lens and produced a run-on
// sentence ("…recoverable spend. is the single most important number").
const makeAudit = () => ({
  selectedPlatforms: ["META"],
  healthScore: 71,
  businessProfileSnapshot: { sectionA: { businessType: "Lead Gen" } },
  normalizedDataset: {
    data: { platforms: { META: { byLevel: { campaign: [] } } } },
    summary: { totals: { spend: 277000, conversions: 5000, currency: "PKR" }, platforms: { META: { spend: 277000, conversions: 5000, currency: "PKR" } } },
  },
  ruleFindings: [
    {
      ruleId: "SEG-WASTE-001",
      platform: "META",
      severity: "CRITICAL",
      category: "Creative Performance",
      title: "The facebook placement is part of the same inefficiency (placement view)",
      detail: "placement lens",
      estimatedImpact:
        "The facebook placement has a PKR 115 cost per result vs the account's PKR 53 baseline cost per result. This is the placement view of an inefficiency the campaign-level finding already counts — acting here recovers part of that same spend, not additional money.",
      fixSteps: ["Review the placement."],
      evidence: { trust: { role: "secondary" }, netRecoverable: 0 },
    },
    {
      ruleId: "CAMP-CPA-001",
      platform: "META",
      severity: "HIGH",
      category: "Campaign Structure",
      title: "Meta cost per result varies sharply by campaign",
      detail: "campaign dispersion",
      estimatedImpact: "PKR 127,408 is recoverable by bringing these campaigns toward the account baseline.",
      fixSteps: ["Isolate the worst campaign."],
      evidence: { trust: { role: "primary" }, netRecoverable: 127408 },
    },
  ],
});

describe("executive-summary clarity", () => {
  const doc = buildReportDocumentFromAudit(makeAudit());

  it("leads the cover with the real primary finding, not the net-0 secondary lens", () => {
    expect(doc.masthead.headline).toContain("varies sharply");
    expect(doc.masthead.headline).not.toMatch(/placement view/i);
  });

  it("produces a clean verdict with no run-on ('. is the')", () => {
    expect(doc.executive_summary.verdict).toMatch(/^The single most important finding/);
    expect(doc.executive_summary.verdict).not.toMatch(/\.\s+is the single most important/);
  });

  it("subline is the primary's complete sentence (no appended fragment)", () => {
    expect(doc.masthead.subline).toBe(
      "PKR 127,408 is recoverable by bringing these campaigns toward the account baseline."
    );
    expect(doc.masthead.subline).not.toMatch(/is the clearest quantified/);
  });
});
