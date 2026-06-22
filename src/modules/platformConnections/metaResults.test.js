import { describe, it, expect } from "vitest";
import {
  resolveResult,
  resolveResultFamilies,
  resolveAccountFamilies,
  resultForFamilies,
} from "./metaResults.service.js";
import { normalizeCampaignInsights } from "./metaNormalizer.service.js";

/**
 * Regression for the 5× messaging under-count (Farooq LD / Herbal Bazaar).
 *
 * A messaging campaign's `actions` array carries BOTH a windowed messaging
 * subset (`messaging_conversation_started_7d`) and the full connection count
 * (`total_messaging_connection`). The old fixed-priority picker ranked the
 * subset first and returned 37 where Meta reports 183 — corrupting the baseline
 * CPA (PKR 336 vs the true PKR 67.91) and every "segment is wasting" figure
 * built on it. Results must take the MAX of the messaging family.
 */
describe("metaResults — objective-aware result resolution", () => {
  it("takes the larger messaging metric, not the windowed subset (the 5× bug)", () => {
    const { results, resultFamily } = resolveResult(
      [
        { action_type: "onsite_conversion.messaging_conversation_started_7d", value: "37" },
        { action_type: "onsite_conversion.total_messaging_connection", value: "161" },
        { action_type: "link_click", value: "272" },
      ],
      { objective: "OUTCOME_ENGAGEMENT" }
    );
    expect(results).toBe(161);
    expect(resultFamily).toBe("messaging");
  });

  it("reconciles the account to 183 across two messaging campaigns", () => {
    const campaigns = normalizeCampaignInsights([
      {
        campaign_name: "New Engagement Campaign",
        objective: "OUTCOME_ENGAGEMENT",
        spend: "7089.36",
        actions: [
          { action_type: "onsite_conversion.messaging_conversation_started_7d", value: "37" },
          { action_type: "onsite_conversion.total_messaging_connection", value: "161" },
        ],
      },
      {
        campaign_name: "Pesh | WA | 23/5",
        objective: "OUTCOME_LEADS",
        spend: "2927.86",
        actions: [
          { action_type: "onsite_conversion.total_messaging_connection", value: "22" },
        ],
      },
    ]);
    const total = campaigns.reduce((s, c) => s + (c.results || 0), 0);
    expect(total).toBe(183); // not 37
    // CPA is spend ÷ results, so it tracks the corrected count.
    expect(campaigns[0].cpa).toBeCloseTo(7089.36 / 161, 2);
  });

  it("a purchase still beats a co-present messaging action for a sales objective", () => {
    const { results, resultFamily } = resolveResult(
      [
        { action_type: "offsite_conversion.fb_pixel_purchase", value: "25" },
        { action_type: "onsite_conversion.total_messaging_connection", value: "300" },
      ],
      { objective: "OUTCOME_SALES" }
    );
    expect(results).toBe(25);
    expect(resultFamily).toBe("purchase");
  });

  it("ad-set optimisation goal overrides the campaign objective", () => {
    // An OUTCOME_LEADS campaign whose ad set optimises for CONVERSATIONS is a
    // messaging result, even though the leads family would be tried first.
    const families = resolveResultFamilies({
      objective: "OUTCOME_LEADS",
      optimizationGoal: "CONVERSATIONS",
    });
    expect(families).toEqual(["messaging"]);
  });

  it("returns null results for an awareness objective (no conversion result)", () => {
    const { results } = resolveResult(
      [{ action_type: "post_engagement", value: "500" }],
      { objective: "OUTCOME_AWARENESS" }
    );
    expect(results).toBeNull();
  });

  it("resolveAccountFamilies picks the dominant-spend objective", () => {
    const families = resolveAccountFamilies([
      { objective: "OUTCOME_ENGAGEMENT", spend: "7089" },
      { objective: "OUTCOME_SALES", spend: "100" },
    ]);
    // Engagement carries the most spend → messaging-led families.
    expect(families[0]).toBe("messaging");
  });

  it("resultForFamilies de-duplicates overlapping purchase variants via max", () => {
    const value = resultForFamilies(
      [
        { action_type: "purchase", value: "25" },
        { action_type: "offsite_conversion.fb_pixel_purchase", value: "25" },
      ],
      ["purchase"]
    );
    expect(value).toBe(25); // not 50
  });
});
