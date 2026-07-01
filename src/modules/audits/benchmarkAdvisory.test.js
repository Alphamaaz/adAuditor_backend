import { describe, it, expect } from "vitest";
import { runDeterministicAudit } from "./auditEngine.service.js";
import { reconcileRecoverable } from "../../lib/findings/recoverable.js";

/**
 * Regression from a REAL corpus account (Google, ~$2.79M spend, summary-only, CTR
 * far below the eCommerce benchmark): BENCH-CTR-001's estimatedImpact text quoted
 * the full account spend, which the recoverable parser scraped and booked as
 * "recoverable" — half of it survived the 50% cap, so the report claimed ~$1.39M
 * recoverable from a CTR gap. A CTR/CPM-vs-benchmark gap is a relative-efficiency
 * signal, not cuttable spend: the finding must still FIRE but carry NO recoverable.
 */
const googleBenchAccount = () => ({
  id: "aud_bench_ctr",
  selectedPlatforms: ["GOOGLE"],
  dataSource: "OAUTH",
  businessProfileSnapshot: { sectionA: { businessType: "eCommerce", currency: "USD" } },
  intakeResponses: [{ section: "PLATFORM_GOOGLE", answers: {} }],
  uploadReadiness: { mode: "FULL" },
  normalizedDataset: {
    summary: {
      totals: { spend: 2787167, conversions: 4000, currency: "USD" },
      // CTR = 200000 / 40000000 = 0.5% — far below the eCommerce Google danger (1.0%).
      platforms: { GOOGLE: { spend: 2787167, conversions: 4000, clicks: 200000, impressions: 40000000, currency: "USD" } },
    },
    data: { platforms: { GOOGLE: { records: [], byLevel: { campaign: [] }, byDimension: {}, byDay: [] } } },
  },
});

const metaCpmAccount = () => ({
  id: "aud_bench_cpm",
  selectedPlatforms: ["META"],
  dataSource: "OAUTH",
  businessProfileSnapshot: { sectionA: { businessType: "B2B SaaS", currency: "USD" } },
  intakeResponses: [{ section: "PLATFORM_META", answers: {} }],
  uploadReadiness: { mode: "FULL" },
  normalizedDataset: {
    summary: {
      totals: { spend: 3000, conversions: 10, currency: "USD" },
      // CPM = 3000 / 20000 * 1000 = $150 — far above the B2B SaaS Meta danger ($60).
      platforms: { META: { spend: 3000, conversions: 10, clicks: 400, impressions: 20000, currency: "USD" } },
    },
    data: { platforms: { META: { records: [], byLevel: { campaign: [{ level: "campaign", name: "C", status: "ACTIVE", spend: 3000, results: 10, clicks: 400, impressions: 20000 }] }, byDimension: {}, byDay: [] } } },
  },
});

describe("benchmark findings are advisory — they never book recoverable spend", () => {
  it("BENCH-CTR-001 fires but carries zero recoverable (no half-the-account claim)", () => {
    const { findings } = runDeterministicAudit(googleBenchAccount());
    const ctr = findings.find((f) => f.ruleId === "BENCH-CTR-001");
    expect(ctr).toBeDefined(); // still a real, valuable finding
    expect(ctr.evidence.advisory).toBe(true);
    expect(ctr.evidence.netRecoverable || 0).toBe(0);
    const { total } = reconcileRecoverable(findings, { accountSpend: 2787167 });
    expect(total).toBe(0); // nothing else recoverable on this summary-only account
  });

  it("BENCH-CPM-001 fires but carries zero recoverable", () => {
    const { findings } = runDeterministicAudit(metaCpmAccount());
    const cpm = findings.find((f) => f.ruleId === "BENCH-CPM-001");
    expect(cpm).toBeDefined();
    expect(cpm.evidence.advisory).toBe(true);
    expect(cpm.evidence.netRecoverable || 0).toBe(0);
  });
});
