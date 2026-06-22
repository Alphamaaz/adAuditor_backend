import { describe, it, expect } from "vitest";
import { runDeterministicAudit } from "./auditEngine.service.js";
import { parseImpactDollars } from "../../lib/findings/priority.js";

/**
 * META-EFF-001 — cost-efficiency divergence on CTR/CPM, no conversions needed.
 * Closes the two gaps SEG-WASTE structurally can't see (the MCP highlighted
 * both): the Instagram-vs-Facebook placement gap (CTR lag) and the 55+ age CPM
 * premium. Must emit no recoverable-dollar figure and must not double-flag a
 * segment SEG-WASTE already reported.
 */
const effAudit = (byDimension) => ({
  id: "aud_eff",
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
          byDimension,
          byDay: [],
          currency: "PKR",
        },
      },
    },
  },
});

describe("META-EFF-001 cost-efficiency divergence", () => {
  it("flags Instagram's CTR lag vs Facebook (no conversions involved)", () => {
    const { findings } = runDeterministicAudit(
      effAudit({
        placement: [
          { dimension: "placement", segment: "facebook", spend: 6085, impressions: 18584, clicks: 783 },
          { dimension: "placement", segment: "instagram", spend: 1004, impressions: 2313, clicks: 23 },
        ],
      })
    );
    const eff = findings.find((f) => f.ruleId === "META-EFF-001");
    expect(eff).toBeDefined();
    expect(eff.evidence.segment).toBe("instagram");
    expect(eff.category).toBe("Creative Performance");
    // No dollar figure → never inflates the recoverable headline.
    expect(parseImpactDollars(eff.estimatedImpact)).toBe(0);
  });

  it("flags a CPM-premium age segment that has a meaningful sample", () => {
    const { findings } = runDeterministicAudit(
      effAudit({
        age: [
          { dimension: "age", segment: "18-24", spend: 4480, impressions: 17018, clicks: 590, conversions: 0 },
          { dimension: "age", segment: "25-34", spend: 4958, impressions: 16090, clicks: 474, conversions: 0 },
          // ~4× the dimension CPM, on a meaningful 1,500-impression sample.
          { dimension: "age", segment: "45-54", spend: 2000, impressions: 1500, clicks: 30, conversions: 0 },
        ],
      })
    );
    const eff = findings.find((f) => f.ruleId === "META-EFF-001" && f.evidence.segment === "45-54");
    expect(eff).toBeDefined();
    expect(eff.evidence.cpmMultipleOfBaseline).toBeGreaterThanOrEqual(2);
  });

  it("does NOT flag a dominant segment against a freak low-impression benchmark (report-14 bug)", () => {
    // Mobile app is 99.7% of spend at a healthy 3% CTR; the only "better" segment
    // is a 21-impression mobile-web freak at 28.57% CTR. Flagging mobile app and
    // telling the user to exclude it would switch the account off.
    const { findings } = runDeterministicAudit(
      effAudit({
        device: [
          { dimension: "device", segment: "mobile_app", spend: 12389, impressions: 39557, clicks: 1210, conversions: 183 },
          { dimension: "device", segment: "mobile_web", spend: 38, impressions: 21, clicks: 6, conversions: 0 },
        ],
      })
    );
    expect(findings.find((f) => f.ruleId === "META-EFF-001")).toBeUndefined();
  });

  it("does not flag geography (region) — META-GEO-001 owns it", () => {
    const { findings } = runDeterministicAudit(
      effAudit({
        region: [
          { dimension: "region", segment: "Punjab", spend: 8000, impressions: 30000, clicks: 900, conversions: 150 },
          { dimension: "region", segment: "England", spend: 2412, impressions: 562, clicks: 6, conversions: 0 },
        ],
      })
    );
    expect(findings.find((f) => f.ruleId === "META-EFF-001")).toBeUndefined();
  });

  it("does not double-flag a segment SEG-WASTE already reported", () => {
    // Instagram is BOTH a CPA waste (worse-than-baseline, ≥10 conversions →
    // SEG-WASTE) AND a CTR-laggard vs Facebook (a META-EFF candidate). SEG-WASTE
    // owns it; META-EFF must defer so it isn't reported twice.
    const audit = {
      id: "aud_dedup",
      selectedPlatforms: ["META"],
      dataSource: "OAUTH",
      businessProfileSnapshot: { sectionA: { businessType: "Lead Gen", currency: "PKR" } },
      intakeResponses: [{ section: "PLATFORM_META", answers: {} }],
      uploadReadiness: { mode: "FULL" },
      normalizedDataset: {
        summary: {
          totals: { spend: 9000, conversions: 110, currency: "PKR" },
          platforms: { META: { spend: 9000, conversions: 110, clicks: 800, impressions: 22000, currency: "PKR" } },
        },
        data: {
          platforms: {
            META: {
              records: [{ level: "campaign", name: "C1", spend: 9000, results: 110 }],
              byLevel: { campaign: [{ level: "campaign", name: "C1", spend: 9000, results: 110 }] },
              byDimension: {
                placement: [
                  { dimension: "placement", segment: "facebook", spend: 6000, impressions: 18000, clicks: 760, conversions: 90 },
                  { dimension: "placement", segment: "instagram", spend: 3000, impressions: 4000, clicks: 40, conversions: 20 },
                ],
              },
              byDay: [],
              currency: "PKR",
            },
          },
        },
      },
    };
    const { findings } = runDeterministicAudit(audit);
    const segWaste = findings.find((f) => f.ruleId === "SEG-WASTE-001" && f.evidence.segment === "instagram");
    const eff = findings.find((f) => f.ruleId === "META-EFF-001" && f.evidence.segment === "instagram");
    expect(segWaste).toBeDefined(); // CPA waste owns it
    expect(eff).toBeUndefined(); // efficiency rule defers
  });

  it("does not fire when segments are uniformly efficient", () => {
    const { findings } = runDeterministicAudit(
      effAudit({
        device: [
          { dimension: "device", segment: "mobile", spend: 6000, impressions: 20000, clicks: 600 },
          { dimension: "device", segment: "desktop", spend: 6000, impressions: 19000, clicks: 580 },
        ],
      })
    );
    expect(findings.find((f) => f.ruleId === "META-EFF-001")).toBeUndefined();
  });
});
