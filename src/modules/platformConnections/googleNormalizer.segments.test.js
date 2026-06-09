import { describe, it, expect } from "vitest";
import { buildGoogleByDimension } from "./googleNormalizer.service.js";
import {
  analyzeDimension,
  baselineCpa,
} from "../../lib/segments/contributionAnalysis.js";

// GAQL shape: row.segments.<field> + row.metrics.* (money in micros).
const deviceRows = [
  { segments: { device: "MOBILE" }, metrics: { costMicros: "200000000", impressions: "12000", clicks: "300", conversions: "0", conversionsValue: "0" } },
  { segments: { device: "DESKTOP" }, metrics: { costMicros: "100000000", impressions: "8000", clicks: "250", conversions: "25", conversionsValue: "0" } },
];

describe("buildGoogleByDimension", () => {
  it("normalizes segment rows into the byDimension record shape", () => {
    const byDimension = buildGoogleByDimension({ device: deviceRows });
    expect(Object.keys(byDimension)).toEqual(["device"]); // empty dims omitted
    const [mobile] = byDimension.device;
    expect(mobile).toMatchObject({
      dimension: "device",
      segment: "MOBILE",
      spend: 200, // 200_000_000 micros / 1e6
      clicks: 300,
      conversions: 0,
    });
  });

  it("omits empty dimensions and tolerates missing input", () => {
    expect(buildGoogleByDimension({})).toEqual({});
    expect(buildGoogleByDimension({ device: [] })).toEqual({});
  });

  it("feeds analyzeDimension so segment waste is detectable (the whole point)", () => {
    const byDimension = buildGoogleByDimension({ device: deviceRows });
    const analysis = analyzeDimension({
      dimension: "device",
      records: byDimension.device,
      baselineCpa: baselineCpa({ spend: 300, conversions: 25 }),
    });
    // MOBILE: 200 spend, 0 conversions, 300 clicks → confident zero-conv waste.
    expect(analysis.worst.segment).toBe("MOBILE");
    expect(analysis.worst.wastedSpend).toBe(200);
    expect(analysis.worst.reason).toBe("zero_conversions");
    expect(analysis.worst.significant).toBe(true);
  });
});
