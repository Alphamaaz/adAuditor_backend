import { describe, it, expect } from "vitest";
import {
  summarizeSegments,
  baselineCpa,
  analyzeDimension,
} from "./contributionAnalysis.js";

describe("summarizeSegments", () => {
  it("computes per-segment cpa and tolerates results vs conversions", () => {
    const out = summarizeSegments([
      { segment: "18-24", spend: 200, clicks: 300, conversions: 10 },
      { segment: "45-54", spend: 172, clicks: 250, results: 1 },
    ]);
    expect(out[0].cpa).toBe(20); // 200/10
    expect(out[1].conversions).toBe(1); // from results
    expect(out[1].cpa).toBe(172);
  });
});

describe("baselineCpa", () => {
  it("divides spend by conversions", () => {
    expect(baselineCpa({ spend: 1000, conversions: 40 })).toBe(25);
  });
  it("returns null when no conversions", () => {
    expect(baselineCpa({ spend: 500, conversions: 0 })).toBeNull();
  });
});

describe("analyzeDimension", () => {
  it("flags a zero-conversion high-spend segment as fully wasted (Essa 45+ case)", () => {
    const result = analyzeDimension({
      dimension: "age",
      baselineCpa: 28,
      minSpend: 50,
      records: [
        { segment: "18-24", spend: 575, clicks: 400, conversions: 21 },
        { segment: "25-34", spend: 729, clicks: 500, conversions: 25 },
        // 45-54: meaningful spend + clicks, zero conversions → full waste
        { segment: "45-54", spend: 206, clicks: 180, conversions: 0 },
      ],
    });
    expect(result.worst).not.toBeNull();
    expect(result.worst.segment).toBe("45-54");
    expect(result.worst.reason).toBe("zero_conversions");
    expect(result.worst.wastedSpend).toBe(206);
    expect(result.worst.significant).toBe(true); // 180 clicks ≥ 100
  });

  it("flags worse-than-baseline CPA segments with partial waste", () => {
    const result = analyzeDimension({
      dimension: "device",
      baselineCpa: 20,
      minSpend: 50,
      records: [
        { segment: "mobile", spend: 1000, clicks: 2000, conversions: 50 }, // cpa 20 = baseline
        { segment: "desktop", spend: 400, clicks: 800, conversions: 10 }, // cpa 40 = 2× baseline
      ],
    });
    const desktop = result.segments.find((s) => s.segment === "desktop");
    // excess = 400 * (1 - 20/40) = 200
    expect(desktop.wastedSpend).toBe(200);
    expect(desktop.reason).toBe("worse_than_baseline");
  });

  it("does not flag a low-sample zero-conversion segment as confident", () => {
    const result = analyzeDimension({
      dimension: "age",
      baselineCpa: 25,
      minSpend: 50,
      records: [{ segment: "65+", spend: 60, clicks: 8, conversions: 0 }],
    });
    // It still computes waste, but the worst() getter requires significance.
    expect(result.worst).toBeNull();
    expect(result.segments[0].significant).toBe(false);
  });

  it("returns no worst when no segment wastes above the floor", () => {
    const result = analyzeDimension({
      dimension: "age",
      baselineCpa: 25,
      minSpend: 50,
      records: [{ segment: "18-24", spend: 500, clicks: 400, conversions: 25 }],
    });
    expect(result.worst).toBeNull();
  });
});
