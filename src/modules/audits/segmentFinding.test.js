import { describe, it, expect } from "vitest";
import { runDeterministicAudit } from "./auditEngine.service.js";
import { buildEvidencePacket } from "./evidencePacket.service.js";
import { parseImpactDollars } from "../../lib/findings/priority.js";

/**
 * Minimal audit with Meta byDimension data containing a wasteful age segment.
 * Proves SEG-WASTE-001 fires in the production engine and flows into the
 * evidence packet that the AI consumes.
 */
const auditWithSegments = () => ({
  id: "aud_seg",
  selectedPlatforms: ["META"],
  dataSource: "OAUTH",
  businessProfileSnapshot: { sectionA: { businessType: "eCommerce" } },
  intakeResponses: [{ section: "PLATFORM_META", answers: {} }],
  uploadReadiness: { mode: "FULL" },
  normalizedDataset: {
    summary: {
      totals: { spend: 1510, conversions: 47 },
      platforms: {
        META: { spend: 1510, conversions: 47, clicks: 1080, impressions: 100000, currency: "PKR" },
      },
    },
    data: {
      platforms: {
        META: {
          records: [{ level: "campaign", name: "C1", spend: 1510 }],
          byLevel: { campaign: [{ level: "campaign", name: "C1", spend: 1510, results: 47 }] },
          byDimension: {
            age: [
              { dimension: "age", segment: "18-24", spend: 575, clicks: 400, conversions: 21 },
              { dimension: "age", segment: "25-34", spend: 729, clicks: 500, conversions: 25 },
              { dimension: "age", segment: "45-54", spend: 206, clicks: 180, conversions: 0 },
            ],
          },
          byDay: [],
        },
      },
    },
  },
});

const auditWithTuesdayWaste = () => ({
  id: "aud_day",
  selectedPlatforms: ["GOOGLE"],
  dataSource: "OAUTH",
  businessProfileSnapshot: { sectionA: { businessType: "eCommerce" } },
  intakeResponses: [{ section: "PLATFORM_GOOGLE", answers: {} }],
  uploadReadiness: { mode: "FULL" },
  normalizedDataset: {
    summary: {
      totals: { spend: 43470, conversions: 270 },
      platforms: {
        GOOGLE: { spend: 43470, conversions: 270, clicks: 3000, impressions: 100000, currency: "PKR" },
      },
    },
    data: {
      platforms: {
        GOOGLE: {
          records: [{ level: "campaign", name: "C1", spend: 43470 }],
          byLevel: { campaign: [{ level: "campaign", name: "C1", spend: 43470, conversions: 270 }] },
          byDimension: {
            day_of_week: [
              { dimension: "day_of_week", segment: "TUESDAY", spend: 7103, clicks: 500, conversions: 27 },
            ],
          },
          byDay: [],
        },
      },
    },
  },
});

describe("SEG-WASTE-001 (production engine)", () => {
  it("fires for the wasteful age segment with rich evidence", () => {
    const { findings } = runDeterministicAudit(auditWithSegments());
    const seg = findings.find((f) => f.ruleId === "SEG-WASTE-001");
    expect(seg).toBeDefined();
    expect(seg.platform).toBe("META");
    expect(seg.evidence.dimension).toBe("age");
    expect(seg.evidence.segment).toBe("45-54");
    expect(seg.evidence.estimatedWaste).toBe(206);
    expect(seg.evidence.segmentCpa).toBeNull(); // zero conversions
    expect(seg.evidence.baselineCpa).toBeGreaterThan(0);
    expect(seg.evidence.reason).toBe("zero_conversions");
    expect(seg.title).toContain("PKR 206");
    expect(seg.estimatedImpact).toContain("PKR 206");
    expect(seg.evidence.currency).toBe("PKR");
    expect(seg.evidence.estimatedWasteFormatted).toBe("PKR 206");
    expect(seg.evidence.baselineCpaFormatted).toMatch(/^PKR /);
  });

  it("formats large PKR segment amounts without truncating digits", () => {
    const { findings } = runDeterministicAudit(auditWithTuesdayWaste());
    const seg = findings.find((f) => f.ruleId === "SEG-WASTE-001");
    expect(seg).toBeDefined();
    expect(seg.evidence.dimension).toBe("day_of_week");
    expect(seg.evidence.spendFormatted).toBe("PKR 7,103");
    expect(JSON.stringify(seg)).not.toContain("PKR 7,03");
    expect(seg.fixSteps.join(" ")).not.toContain("7-day window");
  });

  it("does NOT fire when there is no byDimension data (CSV-only safety)", () => {
    const audit = auditWithSegments();
    audit.normalizedDataset.data.platforms.META.byDimension = {};
    const { findings } = runDeterministicAudit(audit);
    expect(findings.find((f) => f.ruleId === "SEG-WASTE-001")).toBeUndefined();
  });

  it("surfaces the segment finding's dollars in the evidence packet", () => {
    const audit = auditWithSegments();
    const { findings } = runDeterministicAudit(audit);
    const packet = buildEvidencePacket({ ...audit, ruleFindings: findings });
    const segInPacket = packet.topFindings.find((f) => f.ruleId === "SEG-WASTE-001");
    expect(segInPacket).toBeDefined();
    expect(segInPacket.estimatedImpactDollars).toBe(206);
    expect(packet.verifiedNumbers).toContain(206);
  });
});

/**
 * Per-dimension surfacing: when both placement (Audience Network) and a
 * demographic dimension waste money, BOTH must surface — placement waste is no
 * longer hidden just because another dimension wastes marginally more.
 */
describe("SEG-WASTE-001 per-dimension surfacing", () => {
  const auditWithTwoWastefulDimensions = () => ({
    id: "aud_multi_dim",
    selectedPlatforms: ["META"],
    dataSource: "OAUTH",
    businessProfileSnapshot: { sectionA: { businessType: "eCommerce" } },
    intakeResponses: [{ section: "PLATFORM_META", answers: {} }],
    uploadReadiness: { mode: "FULL" },
    normalizedDataset: {
      summary: {
        totals: { spend: 10000, conversions: 100 },
        platforms: { META: { spend: 10000, conversions: 100, clicks: 5000, impressions: 400000, currency: "USD" } },
      },
      data: {
        platforms: {
          META: {
            records: [{ level: "campaign", name: "C1", spend: 10000 }],
            byLevel: { campaign: [{ level: "campaign", name: "C1", spend: 10000, results: 100 }] },
            byDimension: {
              placement: [
                { dimension: "placement", segment: "Audience Network", spend: 2000, clicks: 1000, conversions: 0 },
                { dimension: "placement", segment: "facebook", spend: 6000, clicks: 3000, conversions: 90 },
                { dimension: "placement", segment: "instagram", spend: 2000, clicks: 1000, conversions: 10 },
              ],
              age: [
                { dimension: "age", segment: "55-64", spend: 1500, clicks: 600, conversions: 0 },
                { dimension: "age", segment: "25-34", spend: 8500, clicks: 4400, conversions: 100 },
              ],
            },
            byDay: [],
          },
        },
      },
    },
  });

  it("emits one finding per wasteful dimension (placement AND age)", () => {
    const { findings } = runDeterministicAudit(auditWithTwoWastefulDimensions());
    const seg = findings.filter((f) => f.ruleId === "SEG-WASTE-001");
    const dims = seg.map((f) => f.evidence.dimension);
    expect(dims).toContain("placement");
    expect(dims).toContain("age");
    const placement = seg.find((f) => f.evidence.dimension === "placement");
    expect(placement.evidence.segment).toBe("Audience Network");
  });
});

/**
 * TikTok now carries audience breakdowns (age/gender/country) via the new
 * AUDIENCE report pull, so SEG-WASTE-001 — which is platform-generic — fires for
 * TikTok too. Before this, TikTok byDimension was always {} and segment waste
 * was invisible on TikTok.
 */
describe("SEG-WASTE-001 for TikTok byDimension", () => {
  const tiktokWithAgeWaste = () => ({
    id: "aud_tt_seg",
    selectedPlatforms: ["TIKTOK"],
    dataSource: "OAUTH",
    businessProfileSnapshot: { sectionA: { businessType: "eCommerce" } },
    intakeResponses: [{ section: "PLATFORM_TIKTOK", answers: {} }],
    uploadReadiness: { mode: "FULL" },
    normalizedDataset: {
      summary: {
        totals: { spend: 10000, conversions: 100 },
        platforms: { TIKTOK: { spend: 10000, conversions: 100, clicks: 4800, impressions: 500000, currency: "USD" } },
      },
      data: {
        platforms: {
          TIKTOK: {
            byLevel: { campaign: [{ level: "campaign", name: "TT C1", spend: 10000, conversions: 100 }] },
            byDimension: {
              age: [
                { dimension: "age", segment: "AGE_55_100", spend: 2000, clicks: 800, conversions: 0 },
                { dimension: "age", segment: "AGE_25_34", spend: 8000, clicks: 4000, conversions: 100 },
              ],
            },
            byDay: [],
            currency: "USD",
          },
        },
      },
    },
  });

  it("fires for the wasteful TikTok age segment", () => {
    const { findings } = runDeterministicAudit(tiktokWithAgeWaste());
    const seg = findings.find((f) => f.ruleId === "SEG-WASTE-001" && f.platform === "TIKTOK");
    expect(seg).toBeDefined();
    expect(seg.evidence.dimension).toBe("age");
    expect(seg.evidence.segment).toBe("AGE_55_100");
    expect(seg.category).toBe("Audience Strategy");
  });
});

/**
 * A placement segment that is a LARGE share of spend AND still converts (Facebook
 * at ~62% of spend, 1,420 conversions, 2.2× baseline) must not be told to
 * "exclude" — that throws away real conversions. The advice should be to
 * REBALANCE budget, and the title should read "over baseline efficiency".
 */
const auditWithDominantConvertingPlacement = () => ({
  id: "aud_dom_seg",
  selectedPlatforms: ["META"],
  dataSource: "OAUTH",
  businessProfileSnapshot: { sectionA: { businessType: "Lead Gen", currency: "PKR" } },
  intakeResponses: [{ section: "PLATFORM_META", answers: {} }],
  uploadReadiness: { mode: "FULL" },
  normalizedDataset: {
    summary: {
      totals: { spend: 257696, conversions: 5203, currency: "PKR" },
      platforms: { META: { spend: 257696, conversions: 5203, clicks: 30000, impressions: 600000, currency: "PKR" } },
    },
    data: {
      platforms: {
        META: {
          records: [{ level: "campaign", name: "C1", spend: 257696, results: 5203 }],
          byLevel: { campaign: [{ level: "campaign", name: "C1", spend: 257696, results: 5203 }] },
          byDimension: {
            placement: [
              { dimension: "placement", segment: "facebook", spend: 159000, clicks: 18000, conversions: 1420 }, // ~112 CPA, 62% spend
              { dimension: "placement", segment: "instagram", spend: 98696, clicks: 12000, conversions: 3783 }, // ~26 CPA
            ],
          },
          byDay: [],
          currency: "PKR",
        },
      },
    },
  },
});

describe("SEG-WASTE-001 — dominant converting segment is 'rebalance', not 'exclude'", () => {
  it("reframes a large converting segment as a rebalance, not an exclusion", () => {
    const { findings } = runDeterministicAudit(auditWithDominantConvertingPlacement());
    const seg = findings.find((f) => f.ruleId === "SEG-WASTE-001" && f.evidence.segment === "facebook");
    expect(seg).toBeDefined();
    expect(seg.title).toMatch(/over baseline efficiency/i);
    expect(seg.estimatedImpact).toMatch(/rebalance/i);
    expect(seg.estimatedImpact).not.toMatch(/excluding it/i);
    // The fix step must warn against excluding it outright.
    expect(seg.fixSteps.join(" ")).toMatch(/do NOT exclude|don't exclude|not exclude/i);
    // Money parser must read the RECOVERABLE (~88k), not the CPA (112) that also
    // appears in the text — otherwise the money map + projection mis-report it.
    const parsed = parseImpactDollars(seg.estimatedImpact);
    expect(parsed).toBeGreaterThan(80000);
    expect(parsed).not.toBe(112);
  });
});
