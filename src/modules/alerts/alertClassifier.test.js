import { describe, it, expect } from "vitest";
import { isImmediate, classifyAlerts, detectCpaRegression } from "./alertClassifier.js";

const f = (over = {}) => ({ ruleId: "X", severity: "MEDIUM", estimatedImpact: "", evidence: {}, ...over });

describe("isImmediate — urgency, not just severity", () => {
  it("flags a delivery block", () => {
    expect(isImmediate(f({ evidence: { blocksDelivery: true } }))).toBe(true);
  });
  it("flags a conversion-tracking break", () => {
    expect(isImmediate(f({ ruleId: "GOOGLE-CONV-001", severity: "CRITICAL" }))).toBe(true);
  });
  it("flags live spend at zero conversions", () => {
    expect(isImmediate(f({ evidence: { reason: "zero_conversions" } }))).toBe(true);
  });
  it("flags a large new critical leak", () => {
    expect(isImmediate(f({ severity: "CRITICAL", estimatedImpact: "PKR 6,500 is recoverable" }))).toBe(true);
  });
  it("does NOT flag a diagnostic critical (no real recoverable)", () => {
    expect(isImmediate(f({ severity: "CRITICAL", estimatedImpact: "245% over your PKR 40 target", evidence: { diagnostic: true } }))).toBe(false);
  });
  it("does NOT flag a small/low finding", () => {
    expect(isImmediate(f({ severity: "LOW", estimatedImpact: "PKR 50 recoverable" }))).toBe(false);
    expect(isImmediate(f({ severity: "MEDIUM", estimatedImpact: "Account hygiene risk." }))).toBe(false);
  });
});

describe("classifyAlerts — alert on change, not state", () => {
  const findings = [
    f({ ruleId: "META-POLICY-001", severity: "CRITICAL", evidence: { blocksDelivery: true } }),
    f({ ruleId: "GOOGLE-NAMING-001", severity: "LOW", estimatedImpact: "hygiene" }),
  ];

  it("sends nothing immediate on a first audit (no baseline)", () => {
    const { immediate } = classifyAlerts({ findings, previousRuleIds: [], hasPrevious: false });
    expect(immediate).toHaveLength(0);
  });

  it("alerts only on NEW urgent findings, never on persisting ones", () => {
    // The policy block was already present last audit → known, no re-alert.
    const { immediate, digest } = classifyAlerts({
      findings,
      previousRuleIds: ["META-POLICY-001"],
      hasPrevious: true,
    });
    expect(immediate).toHaveLength(0); // policy block is not new
    expect(digest.map((d) => d.ruleId)).toEqual(["GOOGLE-NAMING-001"]); // new but non-urgent
  });

  it("immediately alerts a newly-appeared delivery block", () => {
    const { immediate } = classifyAlerts({ findings, previousRuleIds: ["GOOGLE-NAMING-001"], hasPrevious: true });
    expect(immediate.map((i) => i.ruleId)).toEqual(["META-POLICY-001"]);
  });
});

describe("detectCpaRegression", () => {
  it("fires on a ≥30% CPA rise with material spend", () => {
    const reg = detectCpaRegression({ totals: { spend: 50000, conversions: 250 }, prevTotals: { spend: 50000, conversions: 400 } });
    expect(reg).not.toBeNull();
    expect(reg.pct).toBe(60); // 200 vs 125
  });
  it("ignores a small rise", () => {
    expect(detectCpaRegression({ totals: { spend: 50000, conversions: 390 }, prevTotals: { spend: 50000, conversions: 400 } })).toBeNull();
  });
  it("ignores thin spend", () => {
    expect(detectCpaRegression({ totals: { spend: 200, conversions: 1 }, prevTotals: { spend: 50000, conversions: 400 } })).toBeNull();
  });
});
