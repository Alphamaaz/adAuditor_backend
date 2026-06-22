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

describe("analyzeDimension — attribution-artifact guards (the Punjab false positive)", () => {
  // A region breakdown where the dominant region (Punjab, ~47% of spend) reports
  // almost no conversions, while the account converts healthily. Its 219×
  // "CPA" is the platform failing to attribute conversions to the region — not
  // recoverable waste. Must NOT be flagged.
  const regions = [
    { segment: "Punjab", spend: 120972, clicks: 14000, conversions: 11 }, // ~10,997 CPA
    { segment: "Sindh", spend: 80000, clicks: 9000, conversions: 3000 },
    { segment: "KPK", spend: 56719, clicks: 7000, conversions: 2192 },
  ];

  it("does not flag a dominant-spend, near-zero-conversion region as waste", () => {
    const out = analyzeDimension({ dimension: "region", records: regions, baselineCpa: 50 });
    const punjab = out.segments.find((s) => s.segment === "Punjab");
    expect(punjab.wastedSpend).toBe(0);
    expect(["under_attributed", "implausible_cpa"]).toContain(punjab.reason);
    // It must not become the dimension's "worst" finding.
    expect(out.worst?.segment).not.toBe("Punjab");
  });

  it("still flags a genuinely wasteful smaller segment (no over-suppression)", () => {
    // Audience-Network-style: 20% of spend, zero conversions, account converts.
    const records = [
      { segment: "audience_network", spend: 2000, clicks: 1000, conversions: 0 },
      { segment: "facebook", spend: 6000, clicks: 3000, conversions: 90 },
      { segment: "instagram", spend: 2000, clicks: 1000, conversions: 10 },
    ];
    const out = analyzeDimension({ dimension: "placement", records, baselineCpa: 100 });
    const an = out.segments.find((s) => s.segment === "audience_network");
    expect(an.reason).toBe("zero_conversions");
    expect(an.wastedSpend).toBe(2000);
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

  // ── Guards (Farooq LD false positives) ──────────────────────────────────────

  it("does not fabricate waste when a dimension has no result attribution (gender)", () => {
    // Account converts (baseline 68), but Meta attributes zero conversions by
    // gender — every gender row is 0. This is "Not available", not waste. (Real
    // Farooq LD split: male 90%, female 9.6%, unknown 0.4%.)
    const result = analyzeDimension({
      dimension: "gender",
      baselineCpa: 68,
      minSpend: 50,
      records: [
        { segment: "male", spend: 11187, clicks: 900, conversions: 0 },
        { segment: "female", spend: 1194, clicks: 90, conversions: 0 },
        { segment: "unknown", spend: 46, clicks: 4, conversions: 0 },
      ],
    });
    expect(result.attributed).toBe(false);
    expect(result.worst).toBeNull();
    expect(result.segments.every((s) => s.wastedSpend === 0)).toBe(true);
    // Female is only 9.6% of spend, so the attribution guard (not dominance) is
    // what spares it — the precise signal that the dimension is unmeasured.
    expect(result.segments.find((s) => s.segment === "female").reason).toBe("unattributed");
  });

  it("does not flag a dominant segment that is ~all of the account's spend (mobile app)", () => {
    // Mobile app is 99.7% of spend — there is nothing to reallocate to.
    const result = analyzeDimension({
      dimension: "device",
      baselineCpa: 68,
      minSpend: 50,
      records: [
        { segment: "mobile_app", spend: 12389, clicks: 1200, conversions: 100 },
        { segment: "mobile_web", spend: 38, clicks: 6, conversions: 0 },
      ],
    });
    const mobileApp = result.segments.find((s) => s.segment === "mobile_app");
    expect(mobileApp.reason).toBe("dominant_segment");
    expect(mobileApp.wastedSpend).toBe(0);
    // mobile_web is below the zero-conv minSpend floor → not a finding either.
    expect(result.worst).toBeNull();
  });

  it("still flags a genuine zero-conv segment when the dimension IS attributed", () => {
    // Other ages convert (dimension attributed), so a zero-conv 45-54 with real
    // clicks remains a true finding — the attribution guard must not over-reach.
    const result = analyzeDimension({
      dimension: "age",
      baselineCpa: 28,
      minSpend: 50,
      records: [
        { segment: "18-24", spend: 575, clicks: 400, conversions: 21 },
        { segment: "45-54", spend: 206, clicks: 180, conversions: 0 },
      ],
    });
    expect(result.attributed).toBe(true);
    expect(result.worst.segment).toBe("45-54");
    expect(result.worst.reason).toBe("zero_conversions");
  });
});
