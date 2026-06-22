import { describe, it, expect } from "vitest";
import { runDeterministicAudit } from "./auditEngine.service.js";

/**
 * META-ADSET-001 / TIKTOK-ADGROUP-001 — the per-campaign dispersion idea pushed
 * down to where targeting actually lives: ad sets on Meta, ad groups on TikTok.
 * A single campaign hides the broken audience; the sub-campaign rule surfaces it.
 */

const metaAudit = () => ({
  id: "aud_meta_adset",
  selectedPlatforms: ["META"],
  dataSource: "OAUTH",
  businessProfileSnapshot: { sectionA: { businessType: "Lead Gen", currency: "PKR" } },
  intakeResponses: [{ section: "PLATFORM_META", answers: {} }],
  uploadReadiness: { mode: "FULL" },
  normalizedDataset: {
    summary: {
      totals: { spend: 30000, conversions: 300 },
      platforms: { META: { spend: 30000, conversions: 300, clicks: 9500, impressions: 200000, currency: "PKR" } },
    },
    data: {
      platforms: {
        META: {
          records: [{ level: "campaign", name: "C1", spend: 30000 }],
          byLevel: {
            campaign: [{ level: "campaign", name: "C1", status: "ACTIVE", spend: 30000, results: 300, clicks: 9500 }],
            adset: [
              { level: "adset", name: "Retargeting", status: "ACTIVE", spend: 8000, results: 125, clicks: 2500 }, // CPA 64
              { level: "adset", name: "Lookalike 1%", status: "ACTIVE", spend: 12000, results: 150, clicks: 4000 }, // CPA 80
              { level: "adset", name: "Broad Interest", status: "ACTIVE", spend: 10000, results: 25, clicks: 3000 }, // CPA 400 → 4× baseline
            ],
            ad: [],
          },
          byDimension: {},
          byDay: [],
          currency: "PKR",
        },
      },
    },
  },
});

const tiktokAudit = () => ({
  id: "aud_tt_adgroup",
  selectedPlatforms: ["TIKTOK"],
  dataSource: "OAUTH",
  businessProfileSnapshot: { sectionA: { businessType: "eCommerce", currency: "USD" } },
  intakeResponses: [{ section: "PLATFORM_TIKTOK", answers: {} }],
  uploadReadiness: { mode: "FULL" },
  normalizedDataset: {
    summary: {
      totals: { spend: 20000, conversions: 200 },
      platforms: { TIKTOK: { spend: 20000, conversions: 200, clicks: 5000, impressions: 300000, currency: "USD" } },
    },
    data: {
      platforms: {
        TIKTOK: {
          byLevel: {
            campaign: [{ level: "campaign", name: "TT C1", status: "ACTIVE", spend: 20000, conversions: 200, clicks: 5000 }],
            adgroup: [
              { name: "AG Lookalike", status: "ACTIVE", spend: 12000, conversions: 190, clicks: 3000 }, // CPA ~63
              { name: "AG Broad", status: "ACTIVE", spend: 8000, conversions: 10, clicks: 2000 }, // CPA 800 → 8× baseline
            ],
            ad: [],
          },
          byDimension: {},
          byDay: {},
          currency: "USD",
        },
      },
    },
  },
});

describe("META-ADSET-001 — ad-set CPA dispersion", () => {
  it("surfaces the broken ad set hidden under one campaign", () => {
    const { findings } = runDeterministicAudit(metaAudit());
    const f = findings.find((x) => x.ruleId === "META-ADSET-001");
    expect(f).toBeDefined();
    expect(f.platform).toBe("META");
    expect(f.severity).toBe("HIGH"); // 4× baseline
    expect(f.category).toBe("Audience Strategy");
    expect(f.evidence.entityNoun).toBe("ad set");
    expect(f.evidence.worstEntity).toBe("Broad Interest");
    expect(f.evidence.bestEntity).toBe("Retargeting");
    expect(f.title).toContain("ad set");
    // Campaign-level CAMP-CPA-001 must NOT fire — there is only one campaign.
    expect(findings.find((x) => x.ruleId === "CAMP-CPA-001")).toBeUndefined();
  });
});

describe("TIKTOK-ADGROUP-001 — ad-group CPA dispersion", () => {
  it("surfaces the broken ad group as CRITICAL at ~8× baseline", () => {
    const { findings } = runDeterministicAudit(tiktokAudit());
    const f = findings.find((x) => x.ruleId === "TIKTOK-ADGROUP-001");
    expect(f).toBeDefined();
    expect(f.platform).toBe("TIKTOK");
    expect(f.severity).toBe("CRITICAL"); // 8× baseline
    expect(f.evidence.entityNoun).toBe("ad group");
    expect(f.evidence.worstEntity).toBe("AG Broad");
    expect(f.evidence.worstMultipleOfBaseline).toBeGreaterThanOrEqual(5);
  });
});
