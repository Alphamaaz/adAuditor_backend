import { describe, it, expect } from "vitest";
import { runDeterministicAudit } from "./auditEngine.service.js";

/**
 * GOOGLE-SEARCH-TERM-001 — query-level waste (the #1 cited Google wasted-spend
 * cause, ~15–30% of budget). The grain (search_term_view) was pulled by the
 * normalizer but never analysed in the live engine; it previously only ran in a
 * shadow rule that never reached a report. Its recoverable pools into the campaign
 * inefficiency (counted once), never stacked.
 */
const mk = (searchTerms, campaigns) => ({
  id: "aud_stwaste",
  selectedPlatforms: ["GOOGLE"],
  dataSource: "OAUTH",
  businessProfileSnapshot: { sectionA: { businessType: "Lead Gen", currency: "PKR", targetCpa: 80 } },
  intakeResponses: [{ section: "PLATFORM_GOOGLE", answers: {} }],
  uploadReadiness: { mode: "FULL" },
  normalizedDataset: {
    summary: {
      totals: { spend: 40000, conversions: 300, currency: "PKR" },
      platforms: { GOOGLE: { spend: 40000, conversions: 300, clicks: 12000, impressions: 200000, currency: "PKR" } },
    },
    data: { platforms: { GOOGLE: { records: [], byLevel: { campaign: campaigns, search_term: searchTerms }, byDimension: {}, byDay: [] } } },
  },
});

const campaigns = [
  { level: "campaign", name: "Search | Core", status: "ENABLED", spend: 40000, results: 300, clicks: 12000, cpa: 133 },
];

describe("GOOGLE-SEARCH-TERM-001", () => {
  it("fires on zero-conversion search terms with material spend + clicks", () => {
    const terms = [
      { level: "search_term", searchTerm: "free download", campaignName: "Search | Core", spend: 6000, clicks: 400, conversions: 0 },
      { level: "search_term", searchTerm: "cheap diy", campaignName: "Search | Core", spend: 4000, clicks: 300, conversions: 0 },
      { level: "search_term", searchTerm: "buy service now", campaignName: "Search | Core", spend: 30000, clicks: 11300, conversions: 300 },
    ];
    const { findings } = runDeterministicAudit(mk(terms, campaigns));
    const f = findings.find((x) => x.ruleId === "GOOGLE-SEARCH-TERM-001");
    expect(f).toBeDefined();
    expect(f.evidence.wastedTermCount).toBe(2);
    expect(f.evidence.wastedSpend).toBe(10000);
    // 10k of 40k search-term spend = 25% → CRITICAL.
    expect(f.severity).toBe("CRITICAL");
    expect(f.evidence.examples.length).toBeGreaterThan(0);
    // Recoverable ≈ wasted × 0.8, but reconciled net never exceeds it.
    expect(f.evidence.netRecoverable).toBeLessThanOrEqual(8000 + 1);
  });

  it("ignores terms below the spend/click gate and terms that convert", () => {
    const terms = [
      { level: "search_term", searchTerm: "tiny", campaignName: "Search | Core", spend: 5, clicks: 2, conversions: 0 }, // too small
      { level: "search_term", searchTerm: "few clicks", campaignName: "Search | Core", spend: 500, clicks: 3, conversions: 0 }, // too few clicks
      { level: "search_term", searchTerm: "converts", campaignName: "Search | Core", spend: 39495, clicks: 11995, conversions: 300 },
    ];
    const { findings } = runDeterministicAudit(mk(terms, campaigns));
    expect(findings.find((x) => x.ruleId === "GOOGLE-SEARCH-TERM-001")).toBeUndefined();
  });

  it("does not stack on the campaign pool — total recoverable stays ≤ reviewed spend", () => {
    const terms = [
      { level: "search_term", searchTerm: "junk a", campaignName: "Search | Core", spend: 6000, clicks: 400, conversions: 0 },
      { level: "search_term", searchTerm: "junk b", campaignName: "Search | Core", spend: 4000, clicks: 300, conversions: 0 },
      { level: "search_term", searchTerm: "good", campaignName: "Search | Core", spend: 30000, clicks: 11300, conversions: 300 },
    ];
    const { findings } = runDeterministicAudit(mk(terms, campaigns));
    const totalNet = findings.reduce((s, f) => s + (Number.isFinite(f.evidence?.netRecoverable) ? f.evidence.netRecoverable : 0), 0);
    expect(totalNet).toBeLessThanOrEqual(40000);
  });
});
