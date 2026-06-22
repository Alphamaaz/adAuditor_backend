import { describe, it, expect } from "vitest";
import {
  parseImpactDollars,
  leverageScore,
  byLeverageDesc,
  isLowConfidence,
} from "./priority.js";

describe("parseImpactDollars", () => {
  it("parses the leading money magnitude in any supported currency", () => {
    expect(parseImpactDollars("PKR 2,277 recoverable this month")).toBe(2277);
    expect(parseImpactDollars("$4,280 in waste")).toBe(4280);
    expect(parseImpactDollars("recover roughly USD 900")).toBe(900);
  });

  it("returns 0 when there is no money figure", () => {
    expect(parseImpactDollars("scaling accelerates losses")).toBe(0);
    expect(parseImpactDollars(null)).toBe(0);
  });
});

describe("leverageScore ordering", () => {
  it("ranks a rate-severe CRITICAL above a larger-dollar MEDIUM (the parity bug)", () => {
    // This is the exact failure mode from the competitor comparison: a paused
    // campaign at 15× CPA (CRITICAL, modest absolute dollars) was ranked BELOW a
    // day-parting tweak (MEDIUM, big absolute dollars). Leverage must reverse it.
    const critical = { severity: "CRITICAL", estimatedImpact: "PKR 500 recoverable" };
    const medium = { severity: "MEDIUM", estimatedImpact: "PKR 90,000 recoverable" };
    expect(leverageScore(critical)).toBeGreaterThan(leverageScore(medium));
    expect([medium, critical].sort(byLeverageDesc)[0]).toBe(critical);
  });

  it("orders findings by recoverable dollars WITHIN a severity band", () => {
    const small = { severity: "HIGH", estimatedImpact: "$100 recoverable" };
    const large = { severity: "HIGH", estimatedImpact: "$5,000 recoverable" };
    expect([small, large].sort(byLeverageDesc)[0]).toBe(large);
  });

  it("demotes thin-sample findings within their severity band", () => {
    const confident = { severity: "HIGH", estimatedImpact: "$100", evidence: {} };
    const thin = {
      severity: "HIGH",
      estimatedImpact: "$100",
      evidence: { significant: false },
    };
    expect(leverageScore(confident)).toBeGreaterThan(leverageScore(thin));
  });

  it("keeps a thin-sample HIGH above a confident MEDIUM (severity still dominates)", () => {
    const thinHigh = {
      severity: "HIGH",
      estimatedImpact: "$100",
      evidence: { significant: false },
    };
    const confidentMedium = {
      severity: "MEDIUM",
      estimatedImpact: "$999,999",
      evidence: {},
    };
    expect(leverageScore(thinHigh)).toBeGreaterThan(leverageScore(confidentMedium));
  });
});

describe("isLowConfidence", () => {
  it("flags explicit significance and low-sample notes", () => {
    expect(isLowConfidence({ evidence: { significant: false } })).toBe(true);
    expect(isLowConfidence({ evidence: { sampleNote: "low sample (below_min)" } })).toBe(true);
    expect(
      isLowConfidence({ evidence: { minSamplePassed: false, confidence: "medium" } })
    ).toBe(true);
  });

  it("treats high-confidence / unflagged findings as confident", () => {
    expect(isLowConfidence({ evidence: { confidence: "high", minSamplePassed: false } })).toBe(false);
    expect(isLowConfidence({ evidence: {} })).toBe(false);
    expect(isLowConfidence({})).toBe(false);
  });
});
