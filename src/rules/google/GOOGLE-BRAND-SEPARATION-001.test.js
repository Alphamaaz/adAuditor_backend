import { describe, it, expect } from "vitest";
import rule from "./GOOGLE-BRAND-SEPARATION-001.rule.js";
import { buildContext } from "../__fixtures__/contextBuilders.js";

const datasetWith = ({ campaigns = [], keywords = [] }) => ({
  summary: {
    totals: {},
    platforms: {
      GOOGLE: {
        uploadedFiles: 1,
        rowCount: campaigns.length + keywords.length,
        spend: 0,
        impressions: 0,
        clicks: 0,
        conversions: 0,
        reach: 0,
      },
    },
  },
  data: {
    platforms: {
      GOOGLE: {
        records: [
          ...campaigns.map((c) => ({ level: "campaign", ...c })),
          ...keywords.map((k) => ({ level: "keyword", ...k })),
        ],
        byLevel: {
          campaign: campaigns.map((c) => ({ level: "campaign", ...c })),
          keyword: keywords.map((k) => ({ level: "keyword", ...k })),
        },
      },
    },
  },
});

const baseCtx = ({ brandTerms, campaigns, keywords }) =>
  buildContext({
    audit: {
      selectedPlatforms: ["GOOGLE"],
      businessProfileSnapshot: {
        sectionA: brandTerms ? { brandTerms } : {},
        sectionB: {},
        sectionC: {},
      },
      intakeResponses: [
        { section: "PLATFORM_META", answers: {} },
        { section: "PLATFORM_GOOGLE", answers: {} },
      ],
    },
    dataset: datasetWith({ campaigns, keywords }),
  });

describe("GOOGLE-BRAND-SEPARATION-001", () => {
  it("returns null when no brand terms are declared", () => {
    const result = rule.eval(
      baseCtx({
        brandTerms: null,
        campaigns: [{ name: "C1" }],
        keywords: [{ name: "acme shoes", campaignName: "C1", spend: 500 }],
      })
    );
    expect(result).toBeNull();
  });

  it("fires when brand keywords appear in non-brand campaigns", () => {
    const ctx = baseCtx({
      brandTerms: ["acme"],
      campaigns: [
        { name: "Brand Campaign" },
        { name: "Generic Shoes" },
      ],
      keywords: [
        // brand campaign: 2 brand keywords
        { name: "acme shoes", campaignName: "Brand Campaign", spend: 200 },
        { name: "buy acme", campaignName: "Brand Campaign", spend: 150 },
        // non-brand campaign: leaks 2 brand keywords
        { name: "acme leak 1", campaignName: "Generic Shoes", spend: 60 },
        { name: "acme leak 2", campaignName: "Generic Shoes", spend: 40 },
        // non-brand campaign: 3 non-brand keywords
        { name: "running shoes", campaignName: "Generic Shoes", spend: 200 },
        { name: "cheap sneakers", campaignName: "Generic Shoes", spend: 200 },
        { name: "comfortable shoes", campaignName: "Generic Shoes", spend: 200 },
      ],
    });
    const result = rule.eval(ctx);
    expect(result).not.toBeNull();
    expect(result.severity).toBe("HIGH");
    expect(result.evidence.brandInNonBrandCount).toBe(2);
    expect(result.evidence.brandInNonBrandSpend).toBe(100);
    expect(result.evidence.brandTerms).toEqual(["acme"]);
  });

  it("fires when non-brand keywords appear in brand campaigns", () => {
    const ctx = baseCtx({
      brandTerms: ["swoosh"],
      campaigns: [
        { name: "Swoosh Brand" }, // name signal → brand campaign
        { name: "Generic" },
      ],
      keywords: [
        // brand campaign: 1 brand, 2 non-brand leaks
        { name: "swoosh shoes", campaignName: "Swoosh Brand", spend: 300 },
        { name: "running shoes", campaignName: "Swoosh Brand", spend: 60 },
        { name: "athletic gear", campaignName: "Swoosh Brand", spend: 40 },
        // non-brand campaign clean
        { name: "running shoes alt", campaignName: "Generic", spend: 100 },
      ],
    });
    const result = rule.eval(ctx);
    expect(result).not.toBeNull();
    expect(result.evidence.nonBrandInBrandCount).toBe(2);
    expect(result.evidence.nonBrandInBrandSpend).toBe(100);
  });

  it("does not fire when mixed spend is below MIN_MIXED_SPEND ($50)", () => {
    const ctx = baseCtx({
      brandTerms: ["acme"],
      campaigns: [{ name: "Brand" }, { name: "Generic" }],
      keywords: [
        { name: "acme one", campaignName: "Brand", spend: 200 },
        { name: "acme leak 1", campaignName: "Generic", spend: 15 },
        { name: "acme leak 2", campaignName: "Generic", spend: 20 },
        { name: "running", campaignName: "Generic", spend: 200 },
        { name: "shoes", campaignName: "Generic", spend: 200 },
      ],
    });
    expect(rule.eval(ctx)).toBeNull();
  });

  it("does not fire when only 1 keyword leaks (below MIN_MIXED_KEYWORDS)", () => {
    const ctx = baseCtx({
      brandTerms: ["acme"],
      campaigns: [{ name: "Brand" }, { name: "Generic" }],
      keywords: [
        { name: "acme one", campaignName: "Brand", spend: 200 },
        { name: "acme leak", campaignName: "Generic", spend: 100 },
        { name: "running", campaignName: "Generic", spend: 200 },
        { name: "shoes", campaignName: "Generic", spend: 200 },
      ],
    });
    expect(rule.eval(ctx)).toBeNull();
  });

  it("matches brand terms case-insensitively but at word boundaries", () => {
    const ctx = baseCtx({
      brandTerms: ["apple"],
      campaigns: [{ name: "Brand" }, { name: "Generic" }],
      keywords: [
        { name: "Apple Watch", campaignName: "Brand", spend: 200 },
        // "pineapple" must NOT count as brand match
        { name: "pineapple recipes", campaignName: "Generic", spend: 200 },
        { name: "fruit recipes", campaignName: "Generic", spend: 200 },
      ],
    });
    const result = rule.eval(ctx);
    expect(result).toBeNull(); // no actual leak after word-boundary filter
  });

  it("accepts brand terms as a comma-separated string in brandTerms field", () => {
    // Ensure Generic stays majority non-brand so it's classified as a
    // non-brand campaign — otherwise its brand leaks become "in-brand-campaign"
    // and fall below MIN_MIXED_KEYWORDS.
    const ctx = baseCtx({
      brandTerms: "acme, swoosh",
      campaigns: [{ name: "Brand" }, { name: "Generic" }],
      keywords: [
        { name: "acme one", campaignName: "Brand", spend: 200 },
        { name: "swoosh leak", campaignName: "Generic", spend: 100 },
        { name: "acme leak", campaignName: "Generic", spend: 100 },
        { name: "running 1", campaignName: "Generic", spend: 200 },
        { name: "running 2", campaignName: "Generic", spend: 200 },
        { name: "running 3", campaignName: "Generic", spend: 200 },
        { name: "running 4", campaignName: "Generic", spend: 200 },
      ],
    });
    const result = rule.eval(ctx);
    expect(result).not.toBeNull();
    expect(new Set(result.evidence.brandTerms)).toEqual(
      new Set(["acme", "swoosh"])
    );
  });

  it("returns null when there are no keywords or campaigns", () => {
    const ctx = baseCtx({
      brandTerms: ["acme"],
      campaigns: [],
      keywords: [],
    });
    expect(rule.eval(ctx)).toBeNull();
  });
});
