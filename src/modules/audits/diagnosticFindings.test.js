import { describe, it, expect } from "vitest";
import { runDeterministicAudit } from "./auditEngine.service.js";

/**
 * DIAG-CPA-001 — production decomposition finding.
 * Meta eCommerce CTR benchmark: good 1.5, warning 0.8, danger 0.4.
 */
const baseAudit = ({ targetCpa, spend, impressions, clicks, conversions }) => ({
  id: "aud_diag",
  selectedPlatforms: ["META"],
  dataSource: "OAUTH",
  businessProfileSnapshot: { sectionA: { businessType: "eCommerce", targetCpa } },
  intakeResponses: [{ section: "PLATFORM_META", answers: {} }],
  uploadReadiness: { mode: "FULL" },
  normalizedDataset: {
    summary: {
      totals: { spend, conversions },
      platforms: { META: { spend, impressions, clicks, conversions, currency: "USD" } },
    },
    data: {
      platforms: {
        META: {
          records: [{ level: "campaign", name: "C1", spend }],
          byLevel: { campaign: [{ level: "campaign", name: "C1", spend, results: conversions }] },
          byDimension: {},
          byDay: [],
        },
      },
    },
  },
});

describe("DIAG-CPA-001 (production decomposition)", () => {
  it("blames conversion_rate when CTR is healthy but CPA over target", () => {
    // CTR = 2000/100000 = 2.0% (above 0.8 warning). CPA = 2000/20 = $100 vs $50 target.
    const audit = baseAudit({ targetCpa: 50, spend: 2000, impressions: 100000, clicks: 2000, conversions: 20 });
    const { findings } = runDeterministicAudit(audit);
    const diag = findings.find((f) => f.ruleId === "DIAG-CPA-001");
    expect(diag).toBeDefined();
    expect(diag.evidence.dominantDriver).toBe("conversion_rate");
    expect(diag.evidence.actualCpa).toBe(100);
    expect(diag.evidence.confidence).toBe("high");
    expect(diag.evidence.minSamplePassed).toBe(true);
    expect(Array.isArray(diag.evidence.explanationFacts)).toBe(true);
  });

  it("blames click_cost when CTR is below benchmark and CPA over target", () => {
    // CTR = 300/100000 = 0.3% (below 0.4 danger). CPA = 1800/20 = $90 vs $50.
    const audit = baseAudit({ targetCpa: 50, spend: 1800, impressions: 100000, clicks: 300, conversions: 20 });
    const { findings } = runDeterministicAudit(audit);
    const diag = findings.find((f) => f.ruleId === "DIAG-CPA-001");
    expect(diag).toBeDefined();
    expect(diag.evidence.dominantDriver).toBe("click_cost");
  });

  it("does NOT fire on a tiny, immaterial sample", () => {
    // spend 100, clicks 20, conversions 2 → gate fails + not material.
    const audit = baseAudit({ targetCpa: 50, spend: 100, impressions: 6000, clicks: 20, conversions: 2 });
    const { findings } = runDeterministicAudit(audit);
    expect(findings.find((f) => f.ruleId === "DIAG-CPA-001")).toBeUndefined();
  });

  it("does NOT fire when no target CPA is declared", () => {
    const audit = baseAudit({ targetCpa: undefined, spend: 2000, impressions: 100000, clicks: 2000, conversions: 20 });
    const { findings } = runDeterministicAudit(audit);
    expect(findings.find((f) => f.ruleId === "DIAG-CPA-001")).toBeUndefined();
  });

  it("does NOT fire when CPA is under target (healthy account)", () => {
    // CPA = 2000/50 = $40 < $50 target.
    const audit = baseAudit({ targetCpa: 50, spend: 2000, impressions: 100000, clicks: 2000, conversions: 50 });
    const { findings } = runDeterministicAudit(audit);
    expect(findings.find((f) => f.ruleId === "DIAG-CPA-001")).toBeUndefined();
  });
});
