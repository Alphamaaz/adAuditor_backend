import { describe, it, expect } from "vitest";
import { runDeterministicAudit } from "./auditEngine.service.js";

/**
 * BENCH-CPM-001 must not fire on a non-USD account. The CPM thresholds are
 * absolute USD; applied to a PKR account they always read "critically above"
 * and fabricate a "PKR 20 CPM target / PKR 11,636 overspend" — the invalid
 * finding that got a live report rejected. CTR (a ratio) is unaffected.
 */
const account = (currency) => ({
  id: "aud_bench",
  selectedPlatforms: ["META"],
  dataSource: "OAUTH",
  businessProfileSnapshot: { sectionA: { businessType: "B2B SaaS", currency } },
  intakeResponses: [{ section: "PLATFORM_META", answers: {} }],
  uploadReadiness: { mode: "FULL" },
  normalizedDataset: {
    summary: {
      totals: { spend: 12427, conversions: 183, currency },
      platforms: { META: { spend: 12427, conversions: 183, clicks: 1217, impressions: 39578, currency } },
    },
    data: {
      platforms: {
        META: {
          records: [{ level: "campaign", name: "C1", spend: 12427, results: 183 }],
          byLevel: { campaign: [{ level: "campaign", name: "C1", spend: 12427, results: 183 }] },
          byDimension: {},
          byDay: [],
          currency,
        },
      },
    },
  },
});

describe("BENCH-CPM-001 currency awareness", () => {
  it("does not fire a CPM benchmark finding on a PKR account", () => {
    const { findings } = runDeterministicAudit(account("PKR"));
    expect(findings.find((f) => f.ruleId === "BENCH-CPM-001")).toBeUndefined();
  });

  it("still fires the CPM benchmark on a USD account (the thresholds are USD)", () => {
    const { findings } = runDeterministicAudit(account("USD"));
    // 12,427 / 39,578 × 1000 = ~314 CPM, far above the USD B2B SaaS danger (60).
    expect(findings.find((f) => f.ruleId === "BENCH-CPM-001")).toBeDefined();
  });
});
