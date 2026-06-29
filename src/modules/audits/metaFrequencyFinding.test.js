import { describe, it, expect } from "vitest";
import { runDeterministicAudit } from "./auditEngine.service.js";

// Phase 2 at 3.50× frequency pays a 69% CPM premium over the fresher Phase 3 at
// 2.06× — the saturation pattern the reference audit flagged. PKR, Meta.
const makeAudit = (campaigns) => ({
  selectedPlatforms: ["META"],
  dataSource: "OAUTH",
  businessProfileSnapshot: { sectionA: { businessType: "Other" } },
  intakeResponses: [],
  normalizedDataset: {
    data: { platforms: { META: { byLevel: { campaign: campaigns }, records: campaigns } } },
    summary: {
      platforms: {
        META: {
          spend: campaigns.reduce((a, c) => a + c.spend, 0),
          conversions: campaigns.reduce((a, c) => a + (c.results || 0), 0),
          impressions: campaigns.reduce((a, c) => a + (c.impressions || 0), 0),
          currency: "PKR",
        },
      },
      totals: { spend: campaigns.reduce((a, c) => a + c.spend, 0), currency: "PKR" },
    },
  },
});

const saturated = [
  { level: "campaign", name: "Phase 2 | bot", status: "ACTIVE", spend: 114794, impressions: 211000, reach: 60286, frequency: 3.5, cpm: 543, results: 1022 },
  { level: "campaign", name: "Phase 3 | new videos", status: "ACTIVE", spend: 52041, impressions: 162322, reach: 78700, frequency: 2.06, cpm: 320, results: 507 },
];

const freqFinding = (audit) =>
  runDeterministicAudit(audit).findings.find((f) => f.ruleId === "META-FREQ-001");

describe("META-FREQ-001 frequency saturation", () => {
  it("flags the saturated campaign with the causal CPM premium vs a fresher peer", () => {
    const f = freqFinding(makeAudit(saturated));
    expect(f).toBeTruthy();
    expect(f.severity).toBe("HIGH"); // 3.5× ≥ FREQ_HIGH
    expect(f.title).toContain("Phase 2 | bot");
    expect(f.evidence.frequency).toBe(3.5);
    expect(f.evidence.cpmPremium).toBeGreaterThanOrEqual(1.3);
    expect(f.evidence.peerCampaign).toBe("Phase 3 | new videos");
    expect(f.detail).toMatch(/CPM is \d+% higher/);
  });

  it("asserts no recoverable dollar (directional efficiency, not cut-able waste)", () => {
    const f = freqFinding(makeAudit(saturated));
    expect(f.evidence.netRecoverable || 0).toBe(0);
    expect(/PKR|\$/.test(f.estimatedImpact)).toBe(false);
  });

  it("does not fire when all campaigns are within a healthy frequency range", () => {
    const healthy = saturated.map((c) => ({ ...c, frequency: 1.8 }));
    expect(freqFinding(makeAudit(healthy))).toBeUndefined();
  });

  it("is MEDIUM (not HIGH) for moderate saturation just over the threshold", () => {
    const moderate = [
      { ...saturated[0], frequency: 2.9, cpm: 430 },
      saturated[1],
    ];
    const f = freqFinding(makeAudit(moderate));
    expect(f).toBeTruthy();
    expect(f.severity).toBe("MEDIUM");
  });

  it("does not fire on a single campaign (no peer to compare)", () => {
    expect(freqFinding(makeAudit([saturated[0]]))).toBeUndefined();
  });
});
