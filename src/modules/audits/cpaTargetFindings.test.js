import { describe, it, expect } from "vitest";
import { runDeterministicAudit } from "./auditEngine.service.js";

/**
 * When a target CPA is declared and the account misses it, two rules used to
 * fire for the same issue: BP-PERF-001 ("CPA significantly above target") and
 * DIAG-CPA-001 ("CPA over target — driven by X"). The diagnosis supersedes the
 * generic alert, so only the diagnosis should remain. And DIAG-CPA-001 is a
 * diagnostic finding — it must carry no recoverable-dollar figure (its narrative
 * references the target value, which must not leak as recovered money).
 */
const overTargetAudit = () => {
  const campaigns = [
    { level: "campaign", name: "C1", status: "ACTIVE", spend: 30000, results: 240, clicks: 18000, impressions: 360000 },
    { level: "campaign", name: "C2", status: "ACTIVE", spend: 20000, results: 160, clicks: 12000, impressions: 240000 },
  ];
  return {
    id: "aud_cpa_target",
    selectedPlatforms: ["GOOGLE"],
    dataSource: "OAUTH",
    businessProfileSnapshot: { sectionA: { businessType: "Lead Gen", currency: "PKR", targetCpa: 40 } },
    intakeResponses: [{ section: "PLATFORM_GOOGLE", answers: {} }],
    uploadReadiness: { mode: "FULL" },
    normalizedDataset: {
      summary: {
        totals: { spend: 50000, conversions: 400, currency: "PKR" },
        platforms: { GOOGLE: { spend: 50000, conversions: 400, clicks: 30000, impressions: 600000, currency: "PKR" } },
      },
      data: { platforms: { GOOGLE: { records: campaigns, byLevel: { campaign: campaigns }, byDimension: {}, byDay: [], currency: "PKR" } } },
    },
  };
};

describe("CPA-over-target findings", () => {
  const { findings } = runDeterministicAudit(overTargetAudit());

  it("DIAG-CPA-001 supersedes BP-PERF-001 (one over-target finding, not two)", () => {
    const diag = findings.find((f) => f.ruleId === "DIAG-CPA-001");
    const alert = findings.find((f) => f.ruleId === "BP-PERF-001");
    expect(diag).toBeDefined();
    expect(alert).toBeUndefined(); // the generic alert is dropped
  });

  it("marks DIAG-CPA-001 diagnostic (no recoverable-dollar leak)", () => {
    const diag = findings.find((f) => f.ruleId === "DIAG-CPA-001");
    expect(diag.evidence.diagnostic).toBe(true);
    // CPA 125 (50000/400) vs target 40, CTR 5% healthy → post-click driver.
    expect(diag.evidence.dominantDriver).toBe("conversion_rate");
  });
});
