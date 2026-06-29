import { describe, it, expect } from "vitest";
import { runDeterministicAudit } from "./auditEngine.service.js";

/**
 * Mixed-family guard for Meta segment findings.
 *
 * Meta breakdown rows (placement/age/geo/…) blend campaigns of different result
 * families but count only the dominant family's conversions. When a click-tier
 * campaign (link_click/traffic) shares material spend with a conversion-tier
 * campaign (messaging/lead/purchase), a segment carrying the click-tier spend
 * reports inflated CPA (its clicks aren't counted as results) → a phantom
 * "wasting PKR X" segment finding. On such accounts the segment-CPA claim can't
 * be trusted, so SEG-WASTE stands down for Meta.
 */

const accountWith = (campaigns) => ({
  id: "aud_mix",
  selectedPlatforms: ["META"],
  dataSource: "OAUTH",
  businessProfileSnapshot: { sectionA: { businessType: "Lead Gen", currency: "PKR", lookbackDays: 30 } },
  intakeResponses: [{ section: "PLATFORM_META", answers: {} }],
  uploadReadiness: { mode: "FULL" },
  normalizedDataset: {
    summary: {
      totals: { spend: 8482, conversions: 201, currency: "PKR" },
      platforms: { META: { spend: 8482, conversions: 201, clicks: 875, impressions: 50000, currency: "PKR" } },
    },
    data: {
      platforms: {
        META: {
          records: campaigns,
          byLevel: { campaign: campaigns },
          // Instagram is clearly "over baseline" (CPA ~91 vs ~42) — but on the
          // mixed account that is an attribution artifact, not real waste.
          byDimension: {
            placement: [
              { dimension: "placement", segment: "facebook", spend: 7120, clicks: 846, conversions: 181 },
              { dimension: "placement", segment: "instagram", spend: 1361, clicks: 29, conversions: 15 },
            ],
          },
          byDay: [],
        },
      },
    },
  },
});

const MIXED = [
  { level: "campaign", name: "New Engagement", status: "ACTIVE", spend: 7089, results: 181, cpa: 39.17, resultFamily: "messaging" },
  { level: "campaign", name: "Kingdom", status: "ACTIVE", spend: 749, results: 5, cpa: 150, resultFamily: "link_click" },
  { level: "campaign", name: "Pesh", status: "ACTIVE", spend: 643, results: 15, cpa: 42.9, resultFamily: "link_click" },
];
const SINGLE_FAMILY = MIXED.map((c) => ({ ...c, resultFamily: "messaging" }));

const igSeg = (findings) =>
  findings.find(
    (f) => f.ruleId === "SEG-WASTE-001" && /instagram/i.test(`${f.title} ${f.evidence?.segment || ""}`)
  );

describe("Meta mixed-family segment guard", () => {
  it("suppresses the segment-CPA finding when click-tier and conversion-tier campaigns mix", () => {
    const { findings } = runDeterministicAudit(accountWith(MIXED));
    expect(igSeg(findings)).toBeUndefined();
  });

  it("still fires the segment finding on a single-family account (control)", () => {
    // Identical breakdown, but every campaign is the same (messaging) family, so
    // the per-segment CPA is trustworthy and the Instagram waste should surface.
    const { findings } = runDeterministicAudit(accountWith(SINGLE_FAMILY));
    expect(igSeg(findings)).toBeDefined();
  });

  it("does not fire a phantom recoverable on the mixed account's money map", () => {
    const { findings } = runDeterministicAudit(accountWith(MIXED));
    const placementWaste = findings.filter(
      (f) => f.ruleId === "SEG-WASTE-001" && /placement/i.test(f.evidence?.dimension || "")
    );
    expect(placementWaste).toHaveLength(0);
  });
});
