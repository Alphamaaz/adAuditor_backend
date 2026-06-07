import { describe, it, expect } from "vitest";
import { baseMetrics, decomposeCpa, decomposeRoas } from "./decomposition.js";

describe("baseMetrics", () => {
  it("computes ctr/cvr/cpm/cpc/cpa from totals", () => {
    const m = baseMetrics({
      spend: 1000,
      impressions: 100000,
      clicks: 2000,
      conversions: 100,
    });
    expect(m.ctr).toBeCloseTo(0.02, 4); // 2000/100000
    expect(m.cvr).toBeCloseTo(0.05, 4); // 100/2000
    expect(m.cpm).toBeCloseTo(10, 2); // 1000/100000*1000
    expect(m.cpc).toBeCloseTo(0.5, 2); // 1000/2000
    expect(m.cpa).toBeCloseTo(10, 2); // 1000/100
  });

  it("handles zero denominators without throwing", () => {
    const m = baseMetrics({ spend: 100, impressions: 0, clicks: 0, conversions: 0 });
    expect(m.ctr).toBeNull();
    expect(m.cpa).toBeNull();
  });
});

describe("decomposeCpa", () => {
  it("attributes drivers without a reference", () => {
    const actual = baseMetrics({ spend: 1000, impressions: 100000, clicks: 2000, conversions: 100 });
    const d = decomposeCpa(actual);
    expect(d).not.toBeNull();
    expect(d.drivers.map((x) => x.name).sort()).toEqual(["CPM", "CTR", "CVR"]);
    const totalPct = d.drivers.reduce((s, x) => s + x.contributionPct, 0);
    expect(totalPct).toBeGreaterThan(95);
    expect(totalPct).toBeLessThan(105);
  });

  it("identifies the dominant driver vs a reference (Essa case: CTR not CPM)", () => {
    // Account vs peer: same CPM, half the CTR, same CVR → CTR should dominate.
    const account = baseMetrics({ spend: 1000, impressions: 100000, clicks: 1000, conversions: 50 });
    const peer = baseMetrics({ spend: 1000, impressions: 100000, clicks: 2000, conversions: 100 });
    const d = decomposeCpa(account, peer);
    expect(d.hasReference).toBe(true);
    expect(d.dominantDriver).toBe("CTR");
  });

  it("returns null when drivers are missing", () => {
    expect(decomposeCpa({ cpm: null, ctr: null, cvr: null })).toBeNull();
  });
});

import { diagnoseCpaDriver } from "./decomposition.js";

describe("diagnoseCpaDriver", () => {
  it("blames conversion_rate when CTR is healthy but CPA over target", () => {
    const d = diagnoseCpaDriver({
      actualCpa: 100,
      targetCpa: 50,
      actualCtr: 2.0,
      benchmarkCtrWarning: 0.8,
      benchmarkCtrGood: 1.5,
    });
    expect(d).not.toBeNull();
    expect(d.dominantDriver).toBe("conversion_rate");
    expect(d.driverDeltas.cpaOverTargetPct).toBe(100);
  });

  it("blames click_cost when CTR is below benchmark and CPA over target", () => {
    const d = diagnoseCpaDriver({
      actualCpa: 90,
      targetCpa: 50,
      actualCtr: 0.3,
      benchmarkCtrWarning: 0.8,
      benchmarkCtrGood: 1.5,
    });
    expect(d.dominantDriver).toBe("click_cost");
  });

  it("returns null when CPA <= target", () => {
    expect(
      diagnoseCpaDriver({ actualCpa: 40, targetCpa: 50, actualCtr: 1, benchmarkCtrWarning: 0.8 })
    ).toBeNull();
  });
});

describe("decomposeRoas", () => {
  it("decomposes into AOV/CVR/CPC", () => {
    const d = decomposeRoas({ aov: 80, cvr: 0.05, cpc: 0.5 });
    expect(d.value).toBeCloseTo(8, 1); // 80*0.05/0.5
    expect(d.drivers.map((x) => x.name).sort()).toEqual(["AOV", "CPC", "CVR"]);
  });
});
