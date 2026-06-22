import { describe, it, expect } from "vitest";
import { runDeterministicAudit } from "./auditEngine.service.js";
import { parseImpactDollars } from "../../lib/findings/priority.js";

/**
 * GOOGLE-ADSTRENGTH-001 (weak RSA Ad Strength) and GOOGLE-EXT-001 (missing ad
 * extensions) — two quick, high-frequency Google wins. Both are quality/reach
 * improvements, so neither emits a recoverable-dollar figure, and GOOGLE-EXT-001
 * stays silent when no extension config was pulled.
 */
const googleAudit = (byLevelExtra, summary = { spend: 50000, conversions: 400, clicks: 18000, impressions: 600000, currency: "PKR" }) => ({
  id: "aud_adq",
  selectedPlatforms: ["GOOGLE"],
  dataSource: "OAUTH",
  businessProfileSnapshot: { sectionA: { businessType: "Lead Gen", currency: "PKR" } },
  intakeResponses: [{ section: "PLATFORM_GOOGLE", answers: {} }],
  uploadReadiness: { mode: "FULL" },
  normalizedDataset: {
    summary: {
      totals: { spend: summary.spend, conversions: summary.conversions },
      platforms: { GOOGLE: summary },
    },
    data: {
      platforms: {
        GOOGLE: {
          records: [],
          byLevel: {
            campaign: [{ level: "campaign", name: "C", status: "ACTIVE", bidStrategy: "TARGET_CPA", objective: "SEARCH", campaignId: "1", spend: summary.spend, results: summary.conversions, clicks: summary.clicks }],
            ...byLevelExtra,
          },
          byDimension: {},
          byDay: [],
          currency: "PKR",
        },
      },
    },
  },
});

describe("GOOGLE-ADSTRENGTH-001 — weak responsive-search-ad strength", () => {
  it("flags POOR/AVERAGE ads on material spend (MEDIUM when any POOR, no recoverable dollars)", () => {
    const { findings } = runDeterministicAudit(
      googleAudit({
        ad: [
          { level: "ad", name: "RSA A", adGroupName: "Brand", status: "ACTIVE", adStrength: "POOR", spend: 4000, impressions: 12000 },
          { level: "ad", name: "RSA B", adGroupName: "Generic", status: "ACTIVE", adStrength: "AVERAGE", spend: 1500, impressions: 6000 },
          { level: "ad", name: "RSA C", adGroupName: "Brand", status: "ACTIVE", adStrength: "EXCELLENT", spend: 9000, impressions: 30000 },
        ],
      })
    );
    const f = findings.find((x) => x.ruleId === "GOOGLE-ADSTRENGTH-001");
    expect(f).toBeDefined();
    expect(f.severity).toBe("MEDIUM");
    expect(f.evidence.weakAdCount).toBe(2);
    expect(f.evidence.worstAd).toBe("RSA A"); // highest-spend weak ad
    expect(parseImpactDollars(f.estimatedImpact)).toBe(0);
  });

  it("is LOW when only AVERAGE (no POOR)", () => {
    const { findings } = runDeterministicAudit(
      googleAudit({
        ad: [{ level: "ad", name: "RSA B", adGroupName: "Generic", status: "ACTIVE", adStrength: "AVERAGE", spend: 2000, impressions: 8000 }],
      })
    );
    const f = findings.find((x) => x.ruleId === "GOOGLE-ADSTRENGTH-001");
    expect(f).toBeDefined();
    expect(f.severity).toBe("LOW");
  });

  it("ignores GOOD/EXCELLENT ads and weak ads below the spend floor", () => {
    const { findings } = runDeterministicAudit(
      googleAudit({
        ad: [
          { level: "ad", name: "Good", adGroupName: "Brand", status: "ACTIVE", adStrength: "GOOD", spend: 9000, impressions: 30000 },
          { level: "ad", name: "Weak but tiny", adGroupName: "X", status: "ACTIVE", adStrength: "POOR", spend: 120, impressions: 400 },
        ],
      })
    );
    expect(findings.find((x) => x.ruleId === "GOOGLE-ADSTRENGTH-001")).toBeUndefined();
  });
});

describe("GOOGLE-EXT-001 — missing ad-extension coverage", () => {
  it("flags a Search campaign with no sitelinks (MEDIUM, no recoverable dollars)", () => {
    const { findings } = runDeterministicAudit(
      googleAudit({
        // Campaign 1 has only a callout — no sitelinks. Campaign asset config IS
        // present (non-empty), so absence is real, not a skipped fetch.
        campaign_asset: [
          { level: "campaign_asset", campaignId: "1", campaignName: "C", channelType: "SEARCH", fieldType: "CALLOUT", status: "ENABLED" },
        ],
      })
    );
    const f = findings.find((x) => x.ruleId === "GOOGLE-EXT-001");
    expect(f).toBeDefined();
    expect(f.severity).toBe("MEDIUM");
    expect(f.evidence.hasSitelinks).toBe(false);
    expect(f.evidence.missingExtensionTypes).toContain("SITELINK");
    expect(parseImpactDollars(f.estimatedImpact)).toBe(0);
  });

  it("does not fire when the campaign has the core extensions", () => {
    const { findings } = runDeterministicAudit(
      googleAudit({
        campaign_asset: [
          { level: "campaign_asset", campaignId: "1", channelType: "SEARCH", fieldType: "SITELINK", status: "ENABLED" },
          { level: "campaign_asset", campaignId: "1", channelType: "SEARCH", fieldType: "CALLOUT", status: "ENABLED" },
          { level: "campaign_asset", campaignId: "1", channelType: "SEARCH", fieldType: "STRUCTURED_SNIPPET", status: "ENABLED" },
        ],
      })
    );
    expect(findings.find((x) => x.ruleId === "GOOGLE-EXT-001")).toBeUndefined();
  });

  it("stays silent when no extension config was pulled (empty)", () => {
    const { findings } = runDeterministicAudit(googleAudit({ campaign_asset: [] }));
    expect(findings.find((x) => x.ruleId === "GOOGLE-EXT-001")).toBeUndefined();
  });
});
