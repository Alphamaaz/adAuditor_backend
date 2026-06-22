import { describe, it, expect } from "vitest";
import { buildTikTokByDimension } from "./tiktokNormalizer.service.js";

/**
 * TikTok audience-report rows → byDimension (the shape SEG-WASTE-001 and the
 * Deep Audit segment tool consume). Before this, TikTok byDimension was {}.
 */
describe("buildTikTokByDimension", () => {
  const ageRows = [
    { dimensions: { advertiser_id: "1", age: "AGE_25_34" }, metrics: { spend: "8000", impressions: "400000", clicks: "4000", conversion: "100" } },
    { dimensions: { advertiser_id: "1", age: "AGE_55_100" }, metrics: { spend: "2000", impressions: "90000", clicks: "800", conversion: "0" } },
    // zero spend + zero impressions → dropped
    { dimensions: { advertiser_id: "1", age: "AGE_13_17" }, metrics: { spend: "0", impressions: "0", clicks: "0", conversion: "0" } },
  ];

  it("maps audience rows into segment records and omits empty dimensions", () => {
    const byDimension = buildTikTokByDimension({ age: ageRows, gender: [], country: [] });
    expect(Object.keys(byDimension)).toEqual(["age"]); // gender/country empty → omitted
    expect(byDimension.age).toHaveLength(2); // the all-zero row is dropped
    const older = byDimension.age.find((r) => r.segment === "AGE_55_100");
    expect(older).toMatchObject({ dimension: "age", spend: 2000, clicks: 800, conversions: 0 });
  });

  it("reads the country_code dimension key", () => {
    const byDimension = buildTikTokByDimension({
      country: [{ dimensions: { country_code: "PK" }, metrics: { spend: "1500", impressions: "50000", clicks: "600", conversion: "2" } }],
    });
    expect(byDimension.country[0].segment).toBe("PK");
    expect(byDimension.country[0].conversions).toBe(2);
  });

  it("returns {} for no breakdowns", () => {
    expect(buildTikTokByDimension({})).toEqual({});
    expect(buildTikTokByDimension()).toEqual({});
  });
});
