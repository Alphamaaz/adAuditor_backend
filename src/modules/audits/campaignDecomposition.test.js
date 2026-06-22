import { describe, it, expect } from "vitest";
import { runDeterministicAudit } from "./auditEngine.service.js";
import { buildEvidencePacket } from "./evidencePacket.service.js";

/**
 * Models the financoach Google account from the competitor-parity comparison:
 * a blended account CPA that hides a wide per-campaign spread —
 *   BD  ~PKR 83   (healthy, TARGET_CPA)
 *   IND ~PKR 117  (MAXIMIZE_CONVERSIONS, no cap)
 *   PK  ~PKR 1,219 (paused, ~10× the account baseline)
 * The competitor led with the PK targeting blow-up; our engine reported a flat
 * account CPA and led with a day-of-week tweak. These tests prove the new
 * per-campaign decomposition + bidding rule + leverage ranking fix that.
 */
const financoachAudit = () => {
  const campaigns = [
    {
      level: "campaign",
      name: "Display | BD | Signals",
      status: "ACTIVE",
      bidStrategy: "TARGET_CPA",
      spend: 17560,
      results: 211,
      clicks: 6649,
    },
    {
      level: "campaign",
      name: "Display | IND | Signals",
      status: "ACTIVE",
      bidStrategy: "MAXIMIZE_CONVERSIONS",
      spend: 15492,
      results: 132,
      clicks: 5581,
    },
    {
      level: "campaign",
      name: "Display | PK | Signals",
      status: "PAUSED",
      bidStrategy: "TARGET_CPA",
      spend: 9750,
      results: 8,
      clicks: 2859,
    },
  ];
  return {
    id: "aud_financoach",
    selectedPlatforms: ["GOOGLE"],
    dataSource: "OAUTH",
    businessProfileSnapshot: {
      sectionA: { businessType: "Lead Gen", targetCpa: 80, currency: "PKR" },
    },
    intakeResponses: [{ section: "PLATFORM_GOOGLE", answers: {} }],
    uploadReadiness: { mode: "FULL" },
    normalizedDataset: {
      summary: {
        totals: { spend: 42802, conversions: 351 },
        platforms: {
          GOOGLE: {
            spend: 42802,
            conversions: 351,
            clicks: 15089,
            impressions: 433215,
            currency: "PKR",
          },
        },
      },
      data: {
        platforms: {
          GOOGLE: {
            records: campaigns,
            byLevel: { campaign: campaigns },
            byDimension: {
              day_of_week: [
                { dimension: "day_of_week", segment: "FRIDAY", spend: 8000, clicks: 600, conversions: 40 },
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

describe("CAMP-CPA-001 — per-campaign CPA dispersion", () => {
  it("surfaces the PK blow-up against the account baseline", () => {
    const { findings } = runDeterministicAudit(financoachAudit());
    const camp = findings.find((f) => f.ruleId === "CAMP-CPA-001");
    expect(camp).toBeDefined();
    expect(camp.severity).toBe("CRITICAL"); // PK is ~10× the baseline
    expect(camp.evidence.worstEntity).toContain("PK");
    expect(camp.evidence.worstMultipleOfBaseline).toBeGreaterThanOrEqual(5);
    expect(camp.evidence.bestEntity).toContain("BD"); // healthiest campaign
    expect(camp.evidence.entityNoun).toBe("campaign");
    expect(camp.evidence.entityBreakdown).toHaveLength(3);
    expect(camp.evidence.currency).toBe("PKR");
    expect(camp.estimatedImpact).toMatch(/^PKR /);
    // The whole point: it must name the healthy campaign to protect, so a reader
    // does not apply an account-wide cut that starves BD.
    expect(camp.detail).toContain("BD");
  });

  it("does NOT fire when campaigns are uniformly near baseline", () => {
    const audit = financoachAudit();
    // Flatten all three campaigns to ~PKR 120 CPA — no dispersion.
    audit.normalizedDataset.data.platforms.GOOGLE.byLevel.campaign = [
      { level: "campaign", name: "A", status: "ACTIVE", bidStrategy: "TARGET_CPA", spend: 12000, results: 100, clicks: 3000 },
      { level: "campaign", name: "B", status: "ACTIVE", bidStrategy: "TARGET_CPA", spend: 12000, results: 100, clicks: 3000 },
      { level: "campaign", name: "C", status: "ACTIVE", bidStrategy: "TARGET_CPA", spend: 12000, results: 100, clicks: 3000 },
    ];
    audit.normalizedDataset.data.platforms.GOOGLE.records =
      audit.normalizedDataset.data.platforms.GOOGLE.byLevel.campaign;
    const { findings } = runDeterministicAudit(audit);
    expect(findings.find((f) => f.ruleId === "CAMP-CPA-001")).toBeUndefined();
  });
});

describe("GOOGLE-BID-001 — uncapped Maximize Conversions", () => {
  it("fires for the IND campaign (MAX_CONV, proven volume, over target)", () => {
    const { findings } = runDeterministicAudit(financoachAudit());
    const bid = findings.filter((f) => f.ruleId === "GOOGLE-BID-001");
    expect(bid).toHaveLength(1);
    expect(bid[0].evidence.campaign).toContain("IND");
    expect(bid[0].evidence.biddingStrategy).toBe("MAXIMIZE_CONVERSIONS");
    expect(bid[0].evidence.referenceBasis).toBe("declared_target");
    expect(bid[0].evidence.percentOverReference).toBeGreaterThan(0);
    expect(bid[0].detail).toContain("MAXIMIZE_CONVERSIONS");
  });

  it("does NOT fire for TARGET_CPA campaigns or paused campaigns", () => {
    const { findings } = runDeterministicAudit(financoachAudit());
    const bid = findings.filter((f) => f.ruleId === "GOOGLE-BID-001");
    const text = JSON.stringify(bid);
    expect(text).not.toContain("BD"); // BD is TARGET_CPA
    expect(text).not.toContain("Display | PK"); // PK is paused
  });
});

describe("leverage ranking in the evidence packet", () => {
  it("leads with the CRITICAL per-campaign finding, not the larger-dollar day-parting one", () => {
    const audit = financoachAudit();
    const { findings } = runDeterministicAudit(audit);
    const packet = buildEvidencePacket({ ...audit, ruleFindings: findings });

    const ids = packet.topFindings.map((f) => f.ruleId);
    const campIdx = ids.indexOf("CAMP-CPA-001");
    const segIdx = ids.indexOf("SEG-WASTE-001"); // the Friday day-parting finding
    const bidIdx = ids.indexOf("GOOGLE-BID-001");

    expect(campIdx).toBe(0); // the rate-severe CRITICAL leads
    if (segIdx !== -1) expect(campIdx).toBeLessThan(segIdx);
    if (bidIdx !== -1) expect(campIdx).toBeLessThan(bidIdx);
  });
});
