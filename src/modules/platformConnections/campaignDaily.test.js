import { describe, it, expect } from "vitest";
import {
  extractCreativeContent,
  enrichAdsWithStructure,
  normalizeCampaignDailyInsights,
} from "./metaNormalizer.service.js";
import { normalizeGoogleCampaignDaily } from "./googleNormalizer.service.js";

// ── Meta creative content extraction ─────────────────────────────────────────

describe("extractCreativeContent", () => {
  it("reads direct title/body/cta", () => {
    expect(
      extractCreativeContent({ title: "Buy now", body: "Great shoes", call_to_action_type: "SHOP_NOW" })
    ).toEqual({ creativeTitle: "Buy now", creativeBody: "Great shoes", creativeCta: "SHOP_NOW" });
  });

  it("falls back to object_story_spec link_data (headline=name, primary text=message)", () => {
    const out = extractCreativeContent({
      object_story_spec: {
        link_data: {
          name: "Free shipping this week",
          message: "Our best sellers are back in stock.",
          call_to_action: { type: "LEARN_MORE" },
        },
      },
    });
    expect(out.creativeTitle).toBe("Free shipping this week");
    expect(out.creativeBody).toBe("Our best sellers are back in stock.");
    expect(out.creativeCta).toBe("LEARN_MORE");
  });

  it("reads video_data and clips long text to 300 chars", () => {
    const out = extractCreativeContent({
      object_story_spec: {
        video_data: { title: "Watch", message: "x".repeat(500), call_to_action: { type: "SIGN_UP" } },
      },
    });
    expect(out.creativeTitle).toBe("Watch");
    expect(out.creativeBody).toHaveLength(300);
    expect(out.creativeCta).toBe("SIGN_UP");
  });

  it("never throws on missing/odd creative", () => {
    expect(extractCreativeContent(null)).toEqual({
      creativeTitle: null,
      creativeBody: null,
      creativeCta: null,
    });
    expect(extractCreativeContent({ object_story_spec: {} }).creativeTitle).toBeNull();
  });
});

describe("enrichAdsWithStructure creative merge", () => {
  it("attaches creative content from the structure record", () => {
    const enriched = enrichAdsWithStructure(
      [{ level: "ad", name: "Ad 1", spend: 100 }],
      [
        {
          name: "Ad 1",
          effective_status: "ACTIVE",
          creative: { title: "Hook", body: "Line", call_to_action_type: "SHOP_NOW" },
        },
      ]
    );
    expect(enriched[0].creativeTitle).toBe("Hook");
    expect(enriched[0].creativeBody).toBe("Line");
    expect(enriched[0].creativeCta).toBe("SHOP_NOW");
    expect(enriched[0].status).toBe("ACTIVE");
  });
});

// ── Meta campaign × day ──────────────────────────────────────────────────────

describe("normalizeCampaignDailyInsights", () => {
  it("maps campaign_name + date_start and resolves results from actions", () => {
    const rows = normalizeCampaignDailyInsights(
      [
        {
          campaign_name: "Alpha",
          date_start: "2026-06-01",
          spend: "150.5",
          impressions: "9000",
          clicks: "120",
          actions: [{ action_type: "purchase", value: "4" }],
        },
      ],
      ["purchase"]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      dimension: "campaign_day",
      name: "Alpha",
      date: "2026-06-01",
      impressions: 9000,
      clicks: 120,
    });
    expect(rows[0].spend).toBeCloseTo(150.5, 1);
    expect(rows[0].conversions).toBe(4);
  });

  it("drops zero-delivery rows", () => {
    const rows = normalizeCampaignDailyInsights(
      [{ campaign_name: "Idle", date_start: "2026-06-01", spend: "0", impressions: "0", actions: [] }],
      []
    );
    expect(rows).toHaveLength(0);
  });
});

// ── Google campaign × day ────────────────────────────────────────────────────

describe("normalizeGoogleCampaignDaily", () => {
  it("converts cost_micros and maps campaign name + segment date", () => {
    const rows = normalizeGoogleCampaignDaily([
      {
        campaign: { id: "1", name: "Search - Brand" },
        segments: { date: "2026-06-02" },
        metrics: {
          costMicros: "12500000",
          impressions: "4000",
          clicks: "300",
          conversions: "12",
          conversionsValue: "480",
        },
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      dimension: "campaign_day",
      name: "Search - Brand",
      date: "2026-06-02",
      impressions: 4000,
      clicks: 300,
      conversions: 12,
    });
    expect(rows[0].spend).toBeCloseTo(12.5, 2);
  });

  it("drops rows without a date or delivery", () => {
    const rows = normalizeGoogleCampaignDaily([
      { campaign: { name: "NoDate" }, metrics: { costMicros: "1000000" } },
      { campaign: { name: "Idle" }, segments: { date: "2026-06-02" }, metrics: {} },
    ]);
    expect(rows).toHaveLength(0);
  });
});
