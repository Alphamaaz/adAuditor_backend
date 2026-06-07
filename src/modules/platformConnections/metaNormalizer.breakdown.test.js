import { describe, it, expect } from "vitest";
import {
  normalizeBreakdownInsights,
  normalizeDailyInsights,
  buildMetaNormalizedDataset,
} from "./metaNormalizer.service.js";

const rawBreakdown = [
  {
    age: "45-54",
    spend: "206.5",
    impressions: "12000",
    clicks: "180",
    reach: "9000",
    actions: [{ action_type: "purchase", value: "0" }],
    cost_per_action_type: [],
  },
  {
    age: "25-34",
    spend: "729",
    impressions: "40000",
    clicks: "500",
    actions: [{ action_type: "purchase", value: "25" }],
    cost_per_action_type: [{ action_type: "purchase", value: "29.16" }],
  },
];

describe("normalizeBreakdownInsights", () => {
  it("maps the breakdown field into segment + parses metrics", () => {
    const rows = normalizeBreakdownInsights(rawBreakdown, "age", "age");
    expect(rows).toHaveLength(2);
    expect(rows[0].dimension).toBe("age");
    expect(rows[0].segment).toBe("45-54");
    expect(rows[0].spend).toBeCloseTo(206.5, 1);
    expect(rows[0].conversions).toBe(0);
    expect(rows[1].segment).toBe("25-34");
    expect(rows[1].conversions).toBe(25);
  });

  it("labels missing segment values as 'unknown'", () => {
    const rows = normalizeBreakdownInsights([{ spend: "10" }], "device", "device_platform");
    expect(rows[0].segment).toBe("unknown");
  });
});

describe("normalizeDailyInsights", () => {
  it("maps date_start to date + parses metrics", () => {
    const rows = normalizeDailyInsights([
      { date_start: "2026-06-01", spend: "100", impressions: "5000", clicks: "80", actions: [] },
    ]);
    expect(rows[0].date).toBe("2026-06-01");
    expect(rows[0].spend).toBe(100);
  });
});

describe("buildMetaNormalizedDataset with byDimension/byDay", () => {
  it("places breakdowns + daily series on the platform object", () => {
    const ds = buildMetaNormalizedDataset({
      campaignRecords: [{ level: "campaign", name: "C1", spend: 1000, results: 40 }],
      adSetRecords: [],
      adRecords: [],
      currency: "PKR",
      byDimension: { age: normalizeBreakdownInsights(rawBreakdown, "age", "age") },
      byDay: normalizeDailyInsights([{ date_start: "2026-06-01", spend: "100", actions: [] }]),
    });
    const meta = ds.data.platforms.META;
    expect(meta.byDimension.age).toHaveLength(2);
    expect(meta.byDay).toHaveLength(1);
    expect(meta.byDay[0].date).toBe("2026-06-01");
  });

  it("defaults to empty structures when breakdowns absent", () => {
    const ds = buildMetaNormalizedDataset({
      campaignRecords: [],
      adSetRecords: [],
      adRecords: [],
      currency: null,
    });
    expect(ds.data.platforms.META.byDimension).toEqual({});
    expect(ds.data.platforms.META.byDay).toEqual([]);
  });
});
