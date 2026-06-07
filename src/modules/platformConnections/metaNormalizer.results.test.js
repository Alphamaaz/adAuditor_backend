import { describe, it, expect } from "vitest";
import {
  normalizeCampaignInsights,
  normalizeAdInsights,
  normalizeBreakdownInsights,
} from "./metaNormalizer.service.js";

/**
 * Objective-spanning result extraction. Before this, the API normalizer read
 * results only from purchase/lead/complete_registration, so messaging,
 * app-install and subscription accounts came back with null results — making
 * cost-per-result uncomputable. The headline case is Essa Traders, a
 * messaging-objective account (action_type
 * `onsite_conversion.messaging_conversation_started_7d`).
 */
describe("metaNormalizer — objective-spanning results", () => {
  it("counts messaging conversations as results (Essa Traders case)", () => {
    const [c] = normalizeCampaignInsights([
      {
        campaign_name: "Tailored messages",
        spend: "483",
        impressions: "1163",
        clicks: "31",
        actions: [
          { action_type: "link_click", value: "12" },
          { action_type: "post_engagement", value: "378" },
          {
            action_type: "onsite_conversion.messaging_conversation_started_7d",
            value: "8",
          },
        ],
        cost_per_action_type: [
          {
            action_type: "onsite_conversion.messaging_conversation_started_7d",
            value: "60.38",
          },
        ],
      },
    ]);
    expect(c.results).toBe(8);
    expect(c.cpa).toBeCloseTo(60.38, 2);
  });

  it("still reports purchases first for sales campaigns (no regression)", () => {
    const [c] = normalizeCampaignInsights([
      {
        campaign_name: "Sales",
        spend: "1000",
        actions: [
          { action_type: "add_to_cart", value: "50" },
          { action_type: "offsite_conversion.fb_pixel_purchase", value: "25" },
        ],
        cost_per_action_type: [
          { action_type: "offsite_conversion.fb_pixel_purchase", value: "40" },
        ],
      },
    ]);
    expect(c.results).toBe(25);
    expect(c.cpa).toBe(40);
  });

  it("counts leads for lead-gen campaigns", () => {
    const [c] = normalizeCampaignInsights([
      { campaign_name: "Leads", actions: [{ action_type: "lead", value: "14" }] },
    ]);
    expect(c.results).toBe(14);
  });

  it("counts app installs (suffix match on mobile_app_install)", () => {
    const [c] = normalizeCampaignInsights([
      {
        campaign_name: "App",
        actions: [{ action_type: "mobile_app_install", value: "120" }],
      },
    ]);
    expect(c.results).toBe(120);
  });

  it("falls through to mid-funnel actions only when no primary conversion exists", () => {
    const [c] = normalizeCampaignInsights([
      { campaign_name: "ToFu", actions: [{ action_type: "add_to_cart", value: "9" }] },
    ]);
    expect(c.results).toBe(9);
  });

  it("returns null when actions carry no recognizable result", () => {
    const [c] = normalizeCampaignInsights([
      {
        campaign_name: "Awareness",
        actions: [{ action_type: "post_engagement", value: "500" }],
      },
    ]);
    expect(c.results).toBeNull();
  });

  it("skips a zero-valued higher-priority result and uses the real one", () => {
    const [c] = normalizeCampaignInsights([
      {
        campaign_name: "Mixed",
        actions: [
          { action_type: "purchase", value: "0" },
          { action_type: "lead", value: "7" },
        ],
      },
    ]);
    expect(c.results).toBe(7);
  });

  it("populates ad-level messaging results", () => {
    const [a] = normalizeAdInsights([
      {
        ad_name: "Ad1",
        actions: [
          {
            action_type: "onsite_conversion.messaging_conversation_started_7d",
            value: "3",
          },
        ],
      },
    ]);
    expect(a.results).toBe(3);
  });

  it("counts messaging results + conversions on breakdown segments", () => {
    const [seg] = normalizeBreakdownInsights(
      [
        {
          age: "25-34",
          spend: "200",
          actions: [
            {
              action_type: "onsite_conversion.messaging_conversation_started_7d",
              value: "6",
            },
          ],
        },
      ],
      "age",
      "age"
    );
    expect(seg.results).toBe(6);
    expect(seg.conversions).toBe(6);
  });
});
