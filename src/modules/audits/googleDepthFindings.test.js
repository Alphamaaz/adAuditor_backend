import { describe, it, expect } from "vitest";
import { runDeterministicAudit } from "./auditEngine.service.js";

/**
 * Engine-level coverage for the device / landing-page / geo depth rules
 * (GOOGLE-DEVICE-001, GOOGLE-LP-001, GOOGLE-GEO-001) — the remaining Google
 * parity gaps from the competitor comparison.
 */
const googleAudit = (byLevelExtra, googleSummary = { spend: 50000, conversions: 400, clicks: 18000, impressions: 600000, currency: "PKR" }) => ({
  id: "aud_depth",
  selectedPlatforms: ["GOOGLE"],
  dataSource: "OAUTH",
  businessProfileSnapshot: { sectionA: { businessType: "Lead Gen", currency: "PKR" } },
  intakeResponses: [{ section: "PLATFORM_GOOGLE", answers: {} }],
  uploadReadiness: { mode: "FULL" },
  normalizedDataset: {
    summary: {
      totals: { spend: googleSummary.spend, conversions: googleSummary.conversions },
      platforms: { GOOGLE: googleSummary },
    },
    data: {
      platforms: {
        GOOGLE: {
          records: [{ level: "campaign", name: "C", spend: googleSummary.spend }],
          byLevel: {
            campaign: [{ level: "campaign", name: "C", status: "ACTIVE", bidStrategy: "TARGET_CPA", spend: googleSummary.spend, results: googleSummary.conversions, clicks: googleSummary.clicks }],
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

describe("GOOGLE-DEVICE-001 — in-campaign device waste", () => {
  it("flags a desktop device burning significant spend at zero conversions", () => {
    const audit = googleAudit({
      campaign_device: [
        { level: "campaign_device", campaignName: "Display | IND | Signals", device: "MOBILE", spend: 17000, clicks: 6500, conversions: 209 },
        // Campaign CPA ≈ 93: PKR 2,400 should have bought ~26 conversions.
        { level: "campaign_device", campaignName: "Display | IND | Signals", device: "DESKTOP", spend: 2400, clicks: 950, conversions: 0 },
      ],
    });
    const { findings } = runDeterministicAudit(audit);
    const dev = findings.find((f) => f.ruleId === "GOOGLE-DEVICE-001");
    expect(dev).toBeDefined();
    expect(dev.evidence.device).toBe("desktop");
    expect(dev.evidence.reason).toBe("zero_conversions");
    expect(dev.evidence.campaign).toContain("IND");
    expect(dev.estimatedImpact).toContain("-100%");
    // Severity is proportional to account share: 2,400 of 50,000 (4.8%) is a
    // MEDIUM cleanup item, not a headline HIGH.
    expect(dev.severity).toBe("MEDIUM");
    expect(dev.evidence.spendSharePercent).toBeCloseTo(4.8, 0);
  });

  it("omits a tiny-sample device slice instead of branding it a finding", () => {
    // PKR 173 (0.3% of account) on 47 clicks could only have bought ~2 expected
    // conversions — observing zero is not statistically meaningful, and the old
    // fixed thresholds (built for USD) branded it a confident finding anyway.
    const audit = googleAudit({
      campaign_device: [
        { level: "campaign_device", campaignName: "Display | IND | Signals", device: "MOBILE", spend: 17000, clicks: 6500, conversions: 209 },
        { level: "campaign_device", campaignName: "Display | IND | Signals", device: "DESKTOP", spend: 173, clicks: 47, conversions: 0 },
      ],
    });
    const { findings } = runDeterministicAudit(audit);
    expect(findings.find((f) => f.ruleId === "GOOGLE-DEVICE-001")).toBeUndefined();
  });
});

describe("GOOGLE-LP-001 — landing-page CVR divergence", () => {
  it("flags the two-domain conversion-rate gap", () => {
    const audit = googleAudit({
      landing_page: [
        { level: "landing_page", url: "http://ads.financoach.com/", spend: 17560, clicks: 6649, conversions: 211 }, // 3.17%
        { level: "landing_page", url: "http://ad.financoach.com/", spend: 11675, clicks: 11675, conversions: 213 }, // 1.82%
      ],
    });
    const { findings } = runDeterministicAudit(audit);
    const lp = findings.find((f) => f.ruleId === "GOOGLE-LP-001");
    expect(lp).toBeDefined();
    expect(lp.evidence.twoDomains).toBe(true);
    expect(lp.evidence.worstUrl).toBe("http://ad.financoach.com/");
    expect(lp.evidence.bestUrl).toBe("http://ads.financoach.com/");
    expect(lp.estimatedImpact).toMatch(/^PKR /);
  });

  it("does not fire when pages converge", () => {
    const audit = googleAudit({
      landing_page: [
        { level: "landing_page", url: "http://a.com/", spend: 5000, clicks: 2000, conversions: 60 }, // 3.0%
        { level: "landing_page", url: "http://b.com/", spend: 5000, clicks: 2000, conversions: 58 }, // 2.9%
      ],
    });
    const { findings } = runDeterministicAudit(audit);
    expect(findings.find((f) => f.ruleId === "GOOGLE-LP-001")).toBeUndefined();
  });
});

describe("GOOGLE-GEO-001 — spend leaking to under-performing markets", () => {
  it("flags a country burning material spend at zero conversions", () => {
    const audit = googleAudit({
      geo: [
        { level: "geo", country: "Pakistan", countryId: "2586", locationType: "AREA_OF_INTEREST", spend: 3000, clicks: 800, conversions: 0 },
        { level: "geo", country: "Bangladesh", countryId: "2050", locationType: "LOCATION_OF_PRESENCE", spend: 20000, clicks: 6000, conversions: 300 },
      ],
    });
    const { findings } = runDeterministicAudit(audit);
    const geo = findings.find((f) => f.ruleId === "GOOGLE-GEO-001");
    expect(geo).toBeDefined();
    expect(geo.severity).toBe("HIGH");
    expect(geo.evidence.country).toBe("Pakistan");
    expect(geo.evidence.reason).toBe("zero_conversions");
    expect(geo.evidence.spendSharePercent).toBeGreaterThan(0);
  });
});
