import { describe, it, expect } from "vitest";
import {
  buildLargeAccountContext,
  LARGE_ACCOUNT_ENTITY_COUNT,
} from "./large-account.js";

describe("large-account fixture", () => {
  it("produces a Zod-valid context", () => {
    const ctx = buildLargeAccountContext();
    expect(ctx.audit.id).toBe("aud_large_account");
    expect(ctx.audit.selectedPlatforms).toEqual(["META", "GOOGLE", "TIKTOK"]);
    expect(ctx.dataset).not.toBeNull();
  });

  it("generates approximately 5K-6K entities at default scale", () => {
    const counts = LARGE_ACCOUNT_ENTITY_COUNT();
    expect(counts.total).toBeGreaterThanOrEqual(4500);
    expect(counts.total).toBeLessThanOrEqual(8000);
  });

  it("populates Google search_term level rows", () => {
    const ctx = buildLargeAccountContext();
    const st = ctx.dataset.data.platforms.GOOGLE.byLevel.search_term;
    expect(st.length).toBeGreaterThan(100);
    // At least some are "wasted" (spend≥20 + clicks≥10 + zero conversions)
    const wasted = st.filter(
      (s) => s.spend >= 20 && s.clicks >= 10 && s.conversions === 0
    );
    expect(wasted.length).toBeGreaterThan(0);
  });

  it("contains brand keywords in the dedicated brand campaign", () => {
    const ctx = buildLargeAccountContext();
    const keywords = ctx.dataset.data.platforms.GOOGLE.byLevel.keyword;
    const brandCampaignKws = keywords.filter(
      (k) => k.campaignName === "GOOGLE-Brand-Campaign"
    );
    expect(brandCampaignKws.length).toBeGreaterThan(0);
    expect(
      brandCampaignKws.every((k) => /\b(acme|swoosh)\b/i.test(k.name))
    ).toBe(true);
  });

  it("is deterministic for the same seed", () => {
    const a = buildLargeAccountContext({ seed: 42 });
    const b = buildLargeAccountContext({ seed: 42 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("differs across seeds", () => {
    const a = buildLargeAccountContext({ seed: 1 });
    const b = buildLargeAccountContext({ seed: 2 });
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it("populates all 3 platforms in dataset.data.platforms", () => {
    const ctx = buildLargeAccountContext();
    for (const platform of ["META", "GOOGLE", "TIKTOK"]) {
      const records = ctx.dataset.data.platforms[platform].records;
      expect(records.length).toBeGreaterThan(100);
    }
  });

  it("populates byLevel maps per platform", () => {
    const ctx = buildLargeAccountContext();
    expect(ctx.dataset.data.platforms.META.byLevel.campaign.length).toBeGreaterThan(0);
    expect(ctx.dataset.data.platforms.META.byLevel.adset.length).toBeGreaterThan(0);
    expect(ctx.dataset.data.platforms.META.byLevel.ad.length).toBeGreaterThan(0);
    expect(ctx.dataset.data.platforms.GOOGLE.byLevel.keyword.length).toBeGreaterThan(0);
  });
});
