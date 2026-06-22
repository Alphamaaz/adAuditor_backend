import { describe, it, expect } from "vitest";
import { CURRENCY_CODES, parseMoney } from "./money.js";
import { runDeterministicAudit } from "../modules/audits/auditEngine.service.js";
import { reconcileRecoverable } from "./findings/recoverable.js";

/**
 * The engine is a global SaaS — it was only ever tested with PKR data. These
 * tests prove the money pipeline is currency-AGNOSTIC: every supported currency
 * round-trips through the parser, and the overlap reconciliation produces the
 * same coherent body==headline result regardless of currency.
 */

describe("shared money vocabulary", () => {
  it("parses every supported currency code the engine can emit", () => {
    for (const code of CURRENCY_CODES) {
      // formatMoney emits "<CODE> <amount>" for non-USD, "$<amount>" for USD.
      expect(parseMoney(`${code} 1,234`)).toBe(1234);
    }
    expect(parseMoney("$1,234")).toBe(1234);
  });

  it("does not read CPA/CTR/ROI-style prose tokens as money", () => {
    expect(parseMoney("CPA 200 over target")).toBe(0);
    expect(parseMoney("CTR 3 percent")).toBe(0);
    expect(parseMoney("lifting from 21% toward 59%")).toBe(0);
    expect(parseMoney("ROI 5")).toBe(0);
  });

  it("includes the major global markets a worldwide SaaS will see", () => {
    for (const code of ["USD", "EUR", "GBP", "JPY", "CNY", "BRL", "MXN", "CHF", "NZD", "TRY", "NGN", "KRW"]) {
      expect(CURRENCY_CODES).toContain(code);
    }
  });
});

// A multi-pool overlap account, parameterised by currency. The same shape that
// claimed 95% of spend in PKR must reconcile to ONE figure in any currency.
const overlapAudit = (currency) => ({
  id: `aud_${currency}`,
  selectedPlatforms: ["META"],
  dataSource: "OAUTH",
  businessProfileSnapshot: { sectionA: { businessType: "eCommerce", currency } },
  intakeResponses: [{ section: "PLATFORM_META", answers: {} }],
  uploadReadiness: { mode: "FULL" },
  normalizedDataset: {
    summary: {
      totals: { spend: 100000, conversions: 1000, currency },
      platforms: { META: { spend: 100000, conversions: 1000, clicks: 40000, impressions: 2000000, currency } },
    },
    data: {
      platforms: {
        META: {
          records: [
            { level: "campaign", name: "Camp A", spend: 60000, results: 300 },
            { level: "campaign", name: "Camp B", spend: 40000, results: 700 },
          ],
          byLevel: {
            campaign: [
              { level: "campaign", name: "Camp A", spend: 60000, results: 300 }, // 200 CPA, 3x B
              { level: "campaign", name: "Camp B", spend: 40000, results: 700 }, // ~57 CPA
            ],
          },
          byDimension: {
            placement: [
              { dimension: "placement", segment: "facebook", spend: 70000, clicks: 30000, conversions: 350 },
              { dimension: "placement", segment: "instagram", spend: 30000, clicks: 10000, conversions: 650 },
            ],
          },
          byDay: [],
          currency,
        },
      },
    },
  },
});

describe.each(["USD", "EUR", "JPY", "BRL", "PKR"])("cross-currency coherence (%s)", (currency) => {
  it("reconciles overlapping findings to one non-overlapping figure (body == headline, ≤ cap)", () => {
    const { findings } = runDeterministicAudit(overlapAudit(currency));
    const recoverableFindings = findings.filter(
      (f) => f.evidence?.blocksDelivery !== true && f.evidence?.diagnostic !== true
    );
    const body = recoverableFindings.reduce((s, f) => s + (f.evidence?.netRecoverable || 0), 0);
    const { total: headline } = reconcileRecoverable(recoverableFindings, { accountSpend: 100000 });
    // There IS recoverable waste (Camp A runs 3x Camp B) — and it's counted once.
    expect(body).toBeGreaterThan(0);
    expect(Math.abs(body - headline)).toBeLessThanOrEqual(2);
    expect(body).toBeLessThanOrEqual(50000); // 50% cap
  });
});
