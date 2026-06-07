import { describe, it, expect } from "vitest";
import rule from "./COMPOUND-BRAND-CANNIBALIZATION-001.rule.js";
import { buildContext } from "../__fixtures__/contextBuilders.js";

const datasetWith = ({ googleKeywords = [], metaRecords = [] }) => ({
  summary: {
    totals: {},
    platforms: {
      META: {
        uploadedFiles: 1,
        rowCount: metaRecords.length,
        spend: 0,
        impressions: 0,
        clicks: 0,
        conversions: 0,
        reach: 0,
      },
      GOOGLE: {
        uploadedFiles: 1,
        rowCount: googleKeywords.length,
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
      META: {
        records: metaRecords.map((r) => ({ level: "campaign", ...r })),
      },
      GOOGLE: {
        records: googleKeywords.map((k) => ({ level: "keyword", ...k })),
        byLevel: {
          keyword: googleKeywords.map((k) => ({ level: "keyword", ...k })),
        },
      },
    },
  },
});

const baseCtx = ({ brandTerms, googleKeywords, metaRecords, metaAnswers = {} }) =>
  buildContext({
    audit: {
      selectedPlatforms: ["META", "GOOGLE"],
      businessProfileSnapshot: {
        sectionA: brandTerms ? { brandTerms } : {},
        sectionB: {},
        sectionC: {},
      },
      intakeResponses: [
        { section: "PLATFORM_META", answers: metaAnswers },
        { section: "PLATFORM_GOOGLE", answers: {} },
      ],
    },
    dataset: datasetWith({ googleKeywords, metaRecords }),
  });

describe("COMPOUND-BRAND-CANNIBALIZATION-001", () => {
  it("fires when both signals are present", () => {
    const result = rule.eval(
      baseCtx({
        brandTerms: ["acme"],
        googleKeywords: [
          { name: "acme shoes", campaignName: "Brand", spend: 200 },
          { name: "buy acme", campaignName: "Brand", spend: 150 },
        ],
        metaRecords: [{ name: "C1", spend: 1000 }],
      })
    );
    expect(result).not.toBeNull();
    expect(result.platform).toBe("CROSS_PLATFORM");
    expect(result.severity).toBe("MEDIUM");
    expect(result.evidence.googleBrandSpend).toBe(350);
    expect(result.evidence.googleBrandKeywordCount).toBe(2);
  });

  it("does not fire when no brand terms declared", () => {
    expect(
      rule.eval(
        baseCtx({
          brandTerms: null,
          googleKeywords: [{ name: "acme shoes", spend: 500 }],
          metaRecords: [{ name: "C1", spend: 1000 }],
        })
      )
    ).toBeNull();
  });

  it("does not fire when Google brand spend is below MIN_GOOGLE_BRAND_SPEND ($100)", () => {
    expect(
      rule.eval(
        baseCtx({
          brandTerms: ["acme"],
          googleKeywords: [{ name: "acme one", spend: 50 }],
          metaRecords: [{ name: "C1", spend: 1000 }],
        })
      )
    ).toBeNull();
  });

  it("does not fire when Meta retargeting is explicitly disabled (M5='no')", () => {
    expect(
      rule.eval(
        baseCtx({
          brandTerms: ["acme"],
          googleKeywords: [{ name: "acme shoes", spend: 500 }],
          metaRecords: [{ name: "C1", spend: 1000 }],
          metaAnswers: { M5: "no" },
        })
      )
    ).toBeNull();
  });

  it("fires when M5 is empty but Meta data exists (presumes active retargeting)", () => {
    const result = rule.eval(
      baseCtx({
        brandTerms: ["acme"],
        googleKeywords: [{ name: "acme shoes", spend: 500 }],
        metaRecords: [{ name: "C1", spend: 1000 }],
      })
    );
    expect(result).not.toBeNull();
    expect(result.evidence.metaRetargetingSignal).toBe("presumed_from_data");
  });

  it("does not fire when there is no Meta data at all", () => {
    expect(
      rule.eval(
        baseCtx({
          brandTerms: ["acme"],
          googleKeywords: [{ name: "acme shoes", spend: 500 }],
          metaRecords: [],
        })
      )
    ).toBeNull();
  });

  it("brand-term matching is word-bounded (apple does not match pineapple)", () => {
    expect(
      rule.eval(
        baseCtx({
          brandTerms: ["apple"],
          googleKeywords: [{ name: "pineapple recipes", spend: 500 }],
          metaRecords: [{ name: "C1", spend: 1000 }],
        })
      )
    ).toBeNull();
  });

  it("counts brand spend only from matching keywords, ignores non-brand keywords", () => {
    const result = rule.eval(
      baseCtx({
        brandTerms: ["acme"],
        googleKeywords: [
          { name: "acme shoes", spend: 200 },
          { name: "running shoes", spend: 9999 }, // not counted
          { name: "acme sneakers", spend: 100 },
        ],
        metaRecords: [{ name: "C1", spend: 1000 }],
      })
    );
    expect(result.evidence.googleBrandSpend).toBe(300);
  });
});
