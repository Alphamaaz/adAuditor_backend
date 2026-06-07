import { describe, it, expect } from "vitest";
import {
  extractBreakdowns,
  mergeNormalizedDataset,
} from "./manualUpload.service.js";

describe("extractBreakdowns (CSV)", () => {
  it("builds byDimension.age from an Age-breakdown export", () => {
    const rows = [
      { Age: "18-24", "Amount spent (USD)": "575", Impressions: "40000", "Link clicks": "400", Results: "21" },
      { Age: "25-34", "Amount spent (USD)": "729", Impressions: "50000", "Link clicks": "500", Results: "25" },
      { Age: "45-54", "Amount spent (USD)": "206", Impressions: "12000", "Link clicks": "180", Results: "0" },
    ];
    const { byDimension, byDay } = extractBreakdowns(rows);
    expect(byDimension.age).toHaveLength(3);
    const old = byDimension.age.find((s) => s.segment === "45-54");
    expect(old.spend).toBe(206);
    expect(old.conversions).toBe(0);
    expect(byDay).toEqual([]);
  });

  it("aggregates multi-row segments (e.g. Device × something)", () => {
    const rows = [
      { Device: "mobile", Cost: "100", Clicks: "50", Conversions: "2" },
      { Device: "mobile", Cost: "150", Clicks: "60", Conversions: "3" },
      { Device: "desktop", Cost: "400", Clicks: "80", Conversions: "1" },
    ];
    const { byDimension } = extractBreakdowns(rows);
    const mobile = byDimension.device.find((s) => s.segment === "mobile");
    expect(mobile.spend).toBe(250);
    expect(mobile.conversions).toBe(5);
  });

  it("builds byDay for an account-level daily export (no entity column)", () => {
    const rows = [
      { Day: "2026-06-01", Cost: "100", Impressions: "5000", Clicks: "80", Conversions: "4" },
      { Day: "2026-06-02", Cost: "120", Impressions: "6000", Clicks: "90", Conversions: "5" },
    ];
    const { byDay } = extractBreakdowns(rows);
    expect(byDay).toHaveLength(2);
    expect(byDay[0].date).toBe("2026-06-01");
    expect(byDay[0].spend).toBe(100);
  });

  it("does NOT build byDay when an entity column is present (campaign report w/ dates)", () => {
    const rows = [
      { "Campaign name": "C1", Day: "2026-06-01", "Amount spent (USD)": "100" },
      { "Campaign name": "C1", Day: "2026-06-02", "Amount spent (USD)": "120" },
    ];
    const { byDay } = extractBreakdowns(rows);
    expect(byDay).toEqual([]);
  });

  it("returns empty structures for a normal entity export (no breakdown cols)", () => {
    const rows = [
      { "Campaign name": "C1", "Amount spent (USD)": "1000", Impressions: "50000", "Link clicks": "800", Results: "40" },
    ];
    const { byDimension, byDay } = extractBreakdowns(rows);
    expect(byDimension).toEqual({});
    expect(byDay).toEqual([]);
  });

  it("merges breakdowns into the dataset platform object", () => {
    const merged = mergeNormalizedDataset({
      existingDataset: null,
      platform: "META",
      reportType: "AGE_GENDER_BREAKDOWN",
      uploadedFileId: "f1",
      records: [],
      uploadSummary: { rowCount: 3, spend: 1510, impressions: 100000, clicks: 1080, conversions: 46, reach: 0, currency: "USD" },
      level: "breakdown",
      breakdowns: {
        byDimension: { age: [{ dimension: "age", segment: "45-54", spend: 206, conversions: 0, clicks: 180, impressions: 12000, results: 0 }] },
        byDay: [],
      },
    });
    expect(merged.data.platforms.META.byDimension.age).toHaveLength(1);
    expect(merged.data.platforms.META.byDay).toEqual([]);
  });
});
