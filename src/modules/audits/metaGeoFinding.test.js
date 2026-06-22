import { describe, it, expect } from "vitest";
import { runDeterministicAudit } from "./auditEngine.service.js";

/**
 * META-GEO-001 — the root cause the engine kept missing. The Kingdom campaigns'
 * "zero conversions" and the inflated blended CPM both traced to PKR 2,412
 * delivered to Great Britain at 16.7× the Pakistan CPM (an accidental Locations
 * setting). The country split makes that diagnosable.
 */
const geoAudit = (countryRows) => ({
  id: "aud_geo",
  selectedPlatforms: ["META"],
  dataSource: "OAUTH",
  businessProfileSnapshot: { sectionA: { businessType: "Lead Gen", currency: "PKR" } },
  intakeResponses: [{ section: "PLATFORM_META", answers: {} }],
  uploadReadiness: { mode: "FULL" },
  normalizedDataset: {
    summary: {
      totals: { spend: 12427, conversions: 183, currency: "PKR" },
      platforms: { META: { spend: 12427, conversions: 183, clicks: 411, impressions: 39578, currency: "PKR" } },
    },
    data: {
      platforms: {
        META: {
          records: [{ level: "campaign", name: "C1", spend: 12427, results: 183 }],
          byLevel: { campaign: [{ level: "campaign", name: "C1", spend: 12427, results: 183 }] },
          byDimension: { country: countryRows },
          byDay: [],
          currency: "PKR",
        },
      },
    },
  },
});

describe("META-GEO-001", () => {
  it("flags a foreign country burning spend at a runaway CPM with zero conversions", () => {
    const { findings } = runDeterministicAudit(
      geoAudit([
        { dimension: "country", segment: "Pakistan", spend: 10015, impressions: 39016, clicks: 405, conversions: 183 },
        { dimension: "country", segment: "United Kingdom", spend: 2411, impressions: 562, clicks: 6, conversions: 0 },
      ])
    );
    const geo = findings.find((f) => f.ruleId === "META-GEO-001");
    expect(geo).toBeDefined();
    expect(geo.severity).toBe("CRITICAL");
    expect(geo.evidence.country).toBe("United Kingdom");
    expect(geo.evidence.homeCountry).toBe("Pakistan");
    expect(geo.evidence.cpmMultipleOfHome).toBeGreaterThan(10);
    expect(geo.rootCause).toMatch(/targeting misconfiguration/i);
    expect(geo.detail).toMatch(/auction/i);
  });

  it("does not flag a small, normal-CPM secondary market that converts", () => {
    const { findings } = runDeterministicAudit(
      geoAudit([
        { dimension: "country", segment: "Pakistan", spend: 10000, impressions: 40000, clicks: 400, conversions: 180 },
        { dimension: "country", segment: "India", spend: 500, impressions: 2000, clicks: 20, conversions: 9 },
      ])
    );
    expect(findings.find((f) => f.ruleId === "META-GEO-001")).toBeUndefined();
  });

  it("does not fire with only one country (no comparison possible)", () => {
    const { findings } = runDeterministicAudit(
      geoAudit([
        { dimension: "country", segment: "Pakistan", spend: 12000, impressions: 39000, clicks: 400, conversions: 183 },
      ])
    );
    expect(findings.find((f) => f.ruleId === "META-GEO-001")).toBeUndefined();
  });
});
