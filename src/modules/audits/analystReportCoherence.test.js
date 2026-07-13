import { describe, it, expect } from "vitest";
import { buildReportDocumentFromAudit } from "./reportDocument.service.js";
import { renderBlock } from "./premiumReportRenderer.service.js";
import { usableDeclaredTargetCpa } from "./auditEngine.service.js";

/**
 * Coherence fixes surfaced by the first LIVE analyst runs (2026-07-11):
 *  1. A target CPA declared in another currency (USD 40 vs a PKR account) must
 *     not be scored against account-currency figures.
 *  2. The health-score category chart must reflect MERGED findings — no
 *     "Tracking & Pixel Health · no findings — 100" above an analyst CRITICAL
 *     tracking finding.
 *  3. The what's-working caveat must not read "it Entire account is paused".
 *  4. Money normalization must never truncate prose table cells ("real leads,"
 *     matched as currency "ADS" amount "," and ate the sentence).
 */

const campaign = (name, spend, conversions, over = {}) => ({
  level: "campaign",
  name,
  spend,
  conversions,
  results: conversions,
  impressions: 50000,
  clicks: 1500,
  status: "ACTIVE",
  ...over,
});

const baseAudit = (over = {}) => ({
  id: "aud_coherence",
  selectedPlatforms: ["META"],
  healthScore: 95,
  businessProfileSnapshot: {
    sectionA: { businessType: "Lead Gen", currency: "PKR", targetCpa: null },
  },
  categoryScores: {
    overall: 95,
    platforms: {
      META: {
        score: 95,
        categories: {
          "Tracking & Pixel Health": 100,
          "Campaign Structure": 92,
          "Bidding & Budget": 92,
          "Creative Performance": 100,
        },
        categoryMeta: {
          "Tracking & Pixel Health": { findingCount: 0, applicable: true },
          "Campaign Structure": { findingCount: 1, applicable: true },
          "Bidding & Budget": { findingCount: 1, applicable: true },
          "Creative Performance": { findingCount: 0, applicable: true },
        },
      },
    },
  },
  normalizedDataset: {
    summary: {
      totals: { spend: 6000, conversions: 100, impressions: 100000, clicks: 3000, currency: "PKR" },
      platforms: { META: { spend: 6000, conversions: 100, impressions: 100000, clicks: 3000, currency: "PKR" } },
    },
    data: {
      platforms: {
        META: {
          currency: "PKR",
          byLevel: { campaign: [campaign("Winner", 1000, 50), campaign("Loser", 5000, 50)] },
          byDimension: {},
          byDay: [],
          records: [],
        },
      },
    },
  },
  ruleFindings: [
    {
      ruleId: "META-STRUCT-001",
      platform: "META",
      severity: "MEDIUM",
      title: "Campaign naming is inconsistent",
      detail: "x",
      category: "Campaign Structure",
      estimatedImpact: "Account hygiene risk.",
      evidence: {},
    },
    {
      ruleId: "META-BID-001",
      platform: "META",
      severity: "MEDIUM",
      title: "Uncapped automatic bidding",
      detail: "x",
      category: "Bidding & Budget",
      estimatedImpact: "Needs review.",
      evidence: {},
    },
  ],
  ...over,
});

const analystReportFixture = () => ({
  executiveSummary: "The account has a tracking integrity problem that undermines every CPA read downstream.",
  rootCause: "Conversion measurement is broken across tables.",
  findings: [
    {
      id: "AN-TRACKING-INTEGRITY",
      title: "Conversion counts disagree across tables",
      severity: "CRITICAL",
      category: "tracking",
      campaignRefs: ["Winner"],
      claim: "Campaign table sums to 352, dimensional tables to 236.",
      figures: [],
      recommendation: "Reconcile the pixel event before relaunch.",
      confidence: "high",
    },
  ],
  campaignDeepDives: [],
  ruleFindingDispositions: [
    { ruleId: "META-STRUCT-001", disposition: "confirmed" },
    { ruleId: "META-BID-001", disposition: "confirmed" },
  ],
  recommendations: [
    { priority: 1, action: "Fix tracking first.", expectedImpact: "Trustworthy CPA reads." },
  ],
});

const withAnalyst = (over = {}) =>
  baseAudit({
    analystReport: {
      report: analystReportFixture(),
      verification: { stats: { figuresVerified: 1, figuresDropped: 0 } },
    },
    ...over,
  });

// ── 1. Currency-mismatched declared target ───────────────────────────────────

describe("usableDeclaredTargetCpa", () => {
  const audit = (sectionA) => ({ businessProfileSnapshot: { sectionA } });

  it("passes the declared target through when currencies match", () => {
    const out = usableDeclaredTargetCpa(audit({ targetCpa: 40, currency: "PKR" }), "PKR");
    expect(out.value).toBe(40);
    expect(out.currencyMismatch).toBe(false);
  });

  it("zeroes the target and flags the mismatch when currencies differ", () => {
    const out = usableDeclaredTargetCpa(audit({ targetCpa: 40, currency: "USD" }), "PKR");
    expect(out.value).toBe(0);
    expect(out.currencyMismatch).toBe(true);
    expect(out.declaredRaw).toBe(40);
    expect(out.intakeCurrency).toBe("USD");
  });

  it("keeps legacy behavior when the intake has no currency", () => {
    const out = usableDeclaredTargetCpa(audit({ targetCpa: 40 }), "PKR");
    expect(out.value).toBe(40);
    expect(out.currencyMismatch).toBe(false);
  });

  it("returns 0 quietly when no target is declared", () => {
    const out = usableDeclaredTargetCpa(audit({ currency: "USD" }), "PKR");
    expect(out.value).toBe(0);
    expect(out.currencyMismatch).toBe(false);
  });
});

describe("report with a USD target on a PKR account", () => {
  const audit = baseAudit({
    businessProfileSnapshot: { sectionA: { businessType: "Lead Gen", currency: "USD", targetCpa: 40 } },
  });
  const doc = buildReportDocumentFromAudit(audit);
  const flat = JSON.stringify(doc);

  it("never scores CPA as over/under the mismatched target", () => {
    expect(flat).not.toMatch(/% over target/);
    const scorecard = doc.sections.find((s) => s.id === "scorecard");
    const cpaRow = scorecard.blocks[0].rows.find((r) => /acquisition/i.test(r.metric));
    if (cpaRow) expect(String(cpaRow.target ?? "—")).not.toMatch(/40/);
  });

  it("discloses WHY the saved target was skipped", () => {
    const scorecard = doc.sections.find((s) => s.id === "scorecard");
    expect(scorecard.blocks[0].caption).toMatch(/USD 40.*not scored against this PKR account/);
  });

  it("does not build the funnel table from the mismatched target", () => {
    // No declared usable target and no inferred target → no funnel CVR section.
    expect(doc.sections.find((s) => /funnel/i.test(s.id || ""))).toBeUndefined();
  });
});

// ── 2. Category chart reflects merged findings ───────────────────────────────

describe("health-score category chart with analyst findings merged", () => {
  it("caps the category at 40 and counts the analyst CRITICAL finding", () => {
    const doc = buildReportDocumentFromAudit(withAnalyst());
    const scores = doc.sections.find((s) => s.id === "scores");
    const chart = scores.blocks[0];
    const tracking = (chart.rows || []).find((r) => /Tracking/i.test(r.label));
    expect(tracking).toBeDefined();
    expect(tracking.label).toMatch(/1 finding/);
    expect(tracking.label).not.toMatch(/no findings/);
    expect(tracking.value).toBeLessThanOrEqual(40);
  });

  it("leaves the chart untouched when no analyst report exists", () => {
    const doc = buildReportDocumentFromAudit(baseAudit());
    const scores = doc.sections.find((s) => s.id === "scores");
    const tracking = (scores.blocks[0].rows || []).find((r) => /Tracking/i.test(r.label));
    expect(tracking.value).toBe(100);
    expect(tracking.label).toMatch(/no findings/);
  });
});

// ── 3. What's-working caveat grammar ─────────────────────────────────────────

describe("what's-working caveat with a non-campaign finding title", () => {
  it("quotes the finding instead of rendering 'it Entire account…'", () => {
    const audit = withAnalyst();
    audit.analystReport.report.findings[0].title =
      "Entire account is paused; the only Active campaign has never delivered";
    const doc = buildReportDocumentFromAudit(audit);
    const flat = JSON.stringify(doc);
    expect(flat).not.toMatch(/it Entire account/);
    if (flat.includes("Entire account is paused")) {
      expect(flat).toMatch(/an open finding also covers it/);
    }
  });
});

// ── 4. Prose cells survive money normalization ───────────────────────────────

describe("data_table money normalization", () => {
  const table = (impact) => ({
    type: "data_table",
    currency: "PKR",
    columns: [
      { header: "#", align: "left" },
      { header: "Move", align: "left" },
      { header: "Expected impact", align: "left" },
    ],
    rows: [["1", "Fix tracking", impact]],
  });

  it("keeps full prose sentences intact", () => {
    const prose =
      "Restores trustworthy CPA reads so every downstream decision is based on real leads, not mixed/duplicated events.";
    const html = renderBlock(table(prose));
    expect(html).toContain("Restores trustworthy CPA reads");
    expect(html).not.toContain("ADS ,");
  });

  it("does not truncate 'exit learning, stabilizing…' prose", () => {
    const prose =
      "Concentrates budget into the proven winner and lets the ad set exit learning, stabilizing cost per result.";
    const html = renderBlock(table(prose));
    expect(html).toContain("Concentrates budget into the proven winner");
    expect(html).not.toContain("ING ,");
  });

  it("still normalizes short money cells", () => {
    const html = renderBlock(table("About PKR 8,524 recoverable"));
    expect(html).toContain("PKR 8,524 recoverable");
  });
});
