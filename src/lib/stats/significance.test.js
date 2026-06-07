import { describe, it, expect } from "vitest";
import {
  wilsonInterval,
  isSignificant,
  inLearningPhase,
  gateFinding,
  zeroConversionConfident,
} from "./significance.js";

describe("wilsonInterval", () => {
  it("returns null for non-positive trials", () => {
    expect(wilsonInterval(0, 0)).toBeNull();
    expect(wilsonInterval(5, -1)).toBeNull();
  });

  it("brackets the point estimate", () => {
    const ci = wilsonInterval(50, 1000);
    expect(ci.rate).toBeCloseTo(0.05, 5);
    expect(ci.low).toBeLessThan(ci.rate);
    expect(ci.high).toBeGreaterThan(ci.rate);
  });

  it("is wider at small n", () => {
    const small = wilsonInterval(2, 8);
    const large = wilsonInterval(250, 1000);
    expect(small.width).toBeGreaterThan(large.width);
  });
});

describe("isSignificant", () => {
  it("flags the Essa case (8 conversions / tiny sample) as not significant", () => {
    // 8 results, but as a CVR estimate the denominator (clicks) is tiny.
    const r = isSignificant({ metric: "cvr", denominator: 12 });
    expect(r.significant).toBe(false);
  });

  it("passes when the sample clears the gate", () => {
    expect(isSignificant({ metric: "ctr", denominator: 5000 }).significant).toBe(true);
    expect(isSignificant({ metric: "cpa", denominator: 25 }).significant).toBe(true);
  });

  it("treats unknown metric as significant when n>0", () => {
    expect(isSignificant({ metric: "unknown", denominator: 1 }).significant).toBe(true);
  });
});

describe("gateFinding", () => {
  it("passes when all minimums are met", () => {
    const g = gateFinding({
      spend: 500, clicks: 200, conversions: 15,
      minSpend: 200, minClicks: 100, minConversions: 10,
    });
    expect(g.passed).toBe(true);
    expect(g.surface).toBe(true);
    expect(g.confidence).toBe("high");
  });

  it("does not surface a tiny sample with immaterial spend", () => {
    const g = gateFinding({
      spend: 80, clicks: 20, conversions: 1,
      minSpend: 200, minClicks: 100, minConversions: 10,
      materialSpend: 1000,
    });
    expect(g.passed).toBe(false);
    expect(g.surface).toBe(false);
    expect(g.confidence).toBe("low");
  });

  it("surfaces a thin sample when spend is clearly material", () => {
    const g = gateFinding({
      spend: 5000, clicks: 40, conversions: 2,
      minSpend: 200, minClicks: 100, minConversions: 10,
      materialSpend: 1000,
    });
    expect(g.passed).toBe(false);
    expect(g.surface).toBe(true); // material spend escape hatch
    expect(g.confidence).toBe("medium");
  });
});

describe("zeroConversionConfident", () => {
  it("is confident with enough clicks", () => {
    expect(zeroConversionConfident({ spend: 60, clicks: 150 }).confident).toBe(true);
  });
  it("is confident with material spend even on few clicks", () => {
    expect(zeroConversionConfident({ spend: 800, clicks: 10 }).confident).toBe(true);
  });
  it("is not confident on thin clicks + small spend", () => {
    expect(zeroConversionConfident({ spend: 60, clicks: 10 }).confident).toBe(false);
  });
});

describe("inLearningPhase", () => {
  it("flags Meta below 50 conv/week", () => {
    expect(
      inLearningPhase({ platform: "META", conversionsPerWeek: 16 }).inLearning
    ).toBe(true);
  });
  it("clears Meta at/above 50 conv/week", () => {
    expect(
      inLearningPhase({ platform: "META", conversionsPerWeek: 60 }).inLearning
    ).toBe(false);
  });
  it("returns false for unknown platform", () => {
    expect(inLearningPhase({ platform: "X", conversionsPerWeek: 1 }).inLearning).toBe(false);
  });
});
