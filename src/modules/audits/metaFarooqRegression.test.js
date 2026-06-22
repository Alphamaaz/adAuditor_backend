import { describe, it, expect } from "vitest";
import { runDeterministicAudit } from "./auditEngine.service.js";
import { buildReportDocumentFromAudit } from "./reportDocument.service.js";
import { byLeverageDesc } from "../../lib/findings/priority.js";

/**
 * End-to-end regression for the Farooq LD / Herbal Bazaar audit that the client
 * rejected (My Car engine scored 2.0/10 against a 9.4 manual audit). This locks
 * in the P0 fixes against the real account shape:
 *
 *   - the two segment "waste" false positives must NOT fire
 *       · mobile app is 99.7% of spend  → dominance guard
 *       · gender carries no conversion attribution → attribution guard
 *   - the Kingdom PKR 1,661 zero-conversion waste must surface ONCE, not twice
 *     (campaign + its lone ad set were double-listed)
 *   - the health score must not floor to 0 for a structurally-diagnosable account
 *
 * Conversion counting itself (the 5× messaging under-count) is fixed at the
 * normalizer and covered by metaResults.test.js / metaNormalizer.results.test.js;
 * here the dataset is already normalized with the correct 183 results.
 */
const farooqAccount = () => {
  const campaigns = [
    { level: "campaign", name: "New Engagement Campaign", status: "PAUSED", spend: 7089, results: 161, clicks: 272 },
    { level: "campaign", name: "Pesh | WA | 23/5", status: "PAUSED", spend: 2928, results: 22, clicks: 104 },
    { level: "campaign", name: "Kingdom Testing", status: "PAUSED", spend: 1661, results: 0, clicks: 5 },
    { level: "campaign", name: "Kingdom Testing - broad", status: "PAUSED", spend: 749, results: 0, clicks: 8 },
  ];
  const adsets = [
    { level: "adset", name: "New Engagement Ad Set", campaignName: "New Engagement Campaign", spend: 7089, results: 161, clicks: 272 },
    { level: "adset", name: "New Leads Ad Set - Copy", campaignName: "Pesh | WA | 23/5", spend: 2928, results: 22, clicks: 104 },
    { level: "adset", name: "New Leads Ad Set", campaignName: "Kingdom Testing", spend: 1661, results: 0, clicks: 5 },
  ];
  const ads = [
    // The proven engine — disapproved, gating 88% of results (the MCP's #1 find).
    { level: "ad", name: "New Engagement Ad", campaignName: "New Engagement Campaign", status: "DISAPPROVED", spend: 7089, results: 161, reviewFeedback: "Personal Attributes" },
    { level: "ad", name: "New Leads Ad", campaignName: "Pesh | WA | 23/5", status: "WITH_ISSUES", spend: 2928, results: 22 },
    { level: "ad", name: "New Leads Ad", campaignName: "Kingdom Testing", status: "CAMPAIGN_PAUSED", spend: 1661, results: 0 },
  ];
  return {
    id: "aud_farooq",
    selectedPlatforms: ["META"],
    dataSource: "OAUTH",
    businessProfileSnapshot: { sectionA: { businessType: "Lead Gen", currency: "PKR" } },
    intakeResponses: [{ section: "PLATFORM_META", answers: {} }],
    uploadReadiness: { mode: "FULL" },
    normalizedDataset: {
      summary: {
        totals: { spend: 12427, conversions: 183, currency: "PKR" },
        platforms: {
          META: { spend: 12427, conversions: 183, clicks: 411, impressions: 39578, currency: "PKR" },
        },
      },
      data: {
        platforms: {
          META: {
            records: [...campaigns, ...adsets, ...ads],
            byLevel: { campaign: campaigns, adset: adsets, ad: ads },
            byDimension: {
              // Country split exposes the GB misconfiguration (the zero-conv +
              // high-CPM root cause).
              country: [
                { dimension: "country", segment: "Pakistan", spend: 10015, impressions: 39016, clicks: 405, conversions: 183 },
                { dimension: "country", segment: "United Kingdom", spend: 2411, impressions: 562, clicks: 6, conversions: 0 },
              ],
              // Device IS attributed (mobile app carries the conversions) but
              // mobile app is 99.7% of spend → dominance guard suppresses it.
              device: [
                { dimension: "device", segment: "mobile_app", spend: 12389, clicks: 405, conversions: 183 },
                { dimension: "device", segment: "mobile_web", spend: 38, clicks: 6, conversions: 0 },
              ],
              // Gender carries NO conversion attribution (Meta "Not available")
              // → every row zero → attribution guard suppresses it.
              gender: [
                { dimension: "gender", segment: "male", spend: 11187, clicks: 370, conversions: 0 },
                { dimension: "gender", segment: "female", spend: 1194, clicks: 37, conversions: 0 },
                { dimension: "gender", segment: "unknown", spend: 46, clicks: 4, conversions: 0 },
              ],
            },
            byDay: [],
            currency: "PKR",
          },
        },
      },
    },
  };
};

describe("Farooq LD regression (P0)", () => {
  const { findings, scores } = runDeterministicAudit(farooqAccount());

  it("does not raise the mobile-app or male-gender segment false positives", () => {
    const seg = findings.filter((f) => f.ruleId === "SEG-WASTE-001");
    const segments = seg.map((f) => f.evidence?.segment);
    expect(segments).not.toContain("mobile_app");
    expect(segments).not.toContain("male");
  });

  it("collapses the campaign + lone-ad-set dispersion into a single finding", () => {
    // CAMP-CPA-001 (campaign level) and META-ADSET-001 (ad-set level) describe
    // the same waste on a one-ad-set-per-campaign account. Only the more
    // actionable campaign-level finding should survive.
    const dispersion = findings.filter((f) =>
      /^(CAMP-CPA|META-ADSET)/.test(f.ruleId)
    );
    expect(dispersion).toHaveLength(1);
    expect(dispersion[0].ruleId).toBe("CAMP-CPA-001");
    expect(dispersion[0].rootCause).toBeTruthy();
  });

  it("renders no placeholder 'why' in the report document", () => {
    const auditForReport = {
      ...farooqAccount(),
      ruleFindings: findings,
      categoryScores: scores,
      healthScore: scores.overall,
    };
    const doc = buildReportDocumentFromAudit(auditForReport);
    expect(JSON.stringify(doc)).not.toMatch(/the audit found this pattern/i);
  });

  it("does not floor the health score to zero", () => {
    expect(scores.overall).toBeGreaterThan(0);
  });

  // ── P1: the issues the engine was previously blind to ──────────────────────

  it("catches the disapproved ad and leads with it (the MCP's #1 finding)", () => {
    const policy = findings.find(
      (f) => f.ruleId === "META-POLICY-001" && f.evidence.status === "DISAPPROVED"
    );
    expect(policy).toBeDefined();
    expect(policy.severity).toBe("CRITICAL");
    // Leverage puts the delivery block first, ahead of the CPM benchmark.
    const ranked = [...findings].sort(byLeverageDesc);
    expect(ranked[0].ruleId).toBe("META-POLICY-001");
  });

  it("diagnoses the Great Britain geo misconfiguration", () => {
    const geo = findings.find((f) => f.ruleId === "META-GEO-001");
    expect(geo).toBeDefined();
    expect(geo.evidence.country).toBe("United Kingdom");
    expect(geo.evidence.cpmMultipleOfHome).toBeGreaterThan(10);
  });

  it("does not double-count the GB leak against the campaign waste in the headline", () => {
    const auditForReport = {
      ...farooqAccount(),
      ruleFindings: findings,
      categoryScores: scores,
      healthScore: scores.overall,
    };
    const doc = buildReportDocumentFromAudit(auditForReport);
    const recoverableCell = doc.key_numbers.find((c) => /recoverable/i.test(c.label));
    // The GB geo leak (PKR 2,411) is the same money as the Kingdom campaign
    // waste, so the headline must stay well under a naive sum of every finding.
    const headline = Number(String(recoverableCell.value).replace(/[^\d.]/g, ""));
    expect(headline).toBeLessThan(12427); // never exceeds reviewed spend
  });

  it("opens the report with a root-cause synthesis and a per-campaign deep-dive", () => {
    const doc = buildReportDocumentFromAudit({
      ...farooqAccount(),
      ruleFindings: findings,
      categoryScores: scores,
      healthScore: scores.overall,
    });
    // Executive summary leads with the synthesized real story (policy + geo).
    const story = doc.executive_summary.paragraphs.find((p) => /the real story/i.test(p));
    expect(story).toBeTruthy();
    expect(story).toMatch(/policy review/i);
    expect(story).toMatch(/United Kingdom/i);
    // The per-campaign deep-dive section is present.
    expect(doc.sections.find((s) => s.id === "campaign-deep-dive")).toBeDefined();
  });
});
