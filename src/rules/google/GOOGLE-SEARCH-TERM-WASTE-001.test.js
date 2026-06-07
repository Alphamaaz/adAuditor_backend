import { describe, it, expect } from "vitest";
import rule from "./GOOGLE-SEARCH-TERM-WASTE-001.rule.js";
import { buildContext } from "../__fixtures__/contextBuilders.js";

const datasetWith = (googleSearchTerms) => ({
  summary: {
    totals: {},
    platforms: {
      GOOGLE: {
        uploadedFiles: 1,
        rowCount: googleSearchTerms.length,
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
        records: googleSearchTerms.map((t) => ({ level: "search_term", ...t })),
        byLevel: {
          search_term: googleSearchTerms.map((t) => ({ level: "search_term", ...t })),
        },
      },
    },
  },
});

const baseCtx = (records) =>
  buildContext({
    audit: {
      selectedPlatforms: ["GOOGLE"],
      intakeResponses: [
        { section: "PLATFORM_META", answers: {} },
        { section: "PLATFORM_GOOGLE", answers: {} },
      ],
    },
    dataset: datasetWith(records),
  });

describe("GOOGLE-SEARCH-TERM-WASTE-001", () => {
  it("fires with MEDIUM severity at 5-10% waste share", () => {
    const records = [
      // 6% waste: 60 wasted of 1000 total. Use $30 wasted across 1 term + $940 good spend.
      ...Array.from({ length: 18 }, (_, i) => ({
        name: `good ${i}`,
        spend: 50,
        clicks: 5,
        conversions: 2,
      })),
      { name: "waste term A", spend: 35, clicks: 18, conversions: 0 },
      { name: "waste term B", spend: 25, clicks: 12, conversions: 0 },
    ];
    const result = rule.eval(baseCtx(records));
    expect(result).not.toBeNull();
    expect(result.severity).toBe("MEDIUM");
    expect(result.evidence.wastedTermCount).toBe(2);
    expect(result.evidence.wastedSpend).toBe(60);
  });

  it("fires with HIGH severity at 10-20% waste share", () => {
    const records = [
      ...Array.from({ length: 8 }, (_, i) => ({
        name: `good ${i}`,
        spend: 100,
        clicks: 5,
        conversions: 1,
      })),
      { name: "waste 1", spend: 60, clicks: 20, conversions: 0 },
      { name: "waste 2", spend: 40, clicks: 15, conversions: 0 },
    ];
    const result = rule.eval(baseCtx(records));
    expect(result).not.toBeNull();
    // 100/(800+100) = 11.1%
    expect(result.severity).toBe("HIGH");
  });

  it("fires with CRITICAL severity at >=20% waste share", () => {
    // Scale above MIN_TOTAL_SEARCH_TERM_SPEND ($500)
    const records = [
      ...Array.from({ length: 5 }, (_, i) => ({
        name: `good ${i}`,
        spend: 80,
        clicks: 5,
        conversions: 2,
      })),
      { name: "waste 1", spend: 80, clicks: 20, conversions: 0 },
      { name: "waste 2", spend: 80, clicks: 20, conversions: 0 },
      { name: "waste 3", spend: 80, clicks: 20, conversions: 0 },
    ];
    const result = rule.eval(baseCtx(records));
    expect(result).not.toBeNull();
    // 240/640 = 37.5%
    expect(result.severity).toBe("CRITICAL");
  });

  it("does not fire below 5% waste share", () => {
    const records = [
      ...Array.from({ length: 100 }, (_, i) => ({
        name: `good ${i}`,
        spend: 20,
        clicks: 5,
        conversions: 1,
      })),
      // 1 wasted term at $30 vs $2000 good
      { name: "waste", spend: 30, clicks: 15, conversions: 0 },
    ];
    expect(rule.eval(baseCtx(records))).toBeNull();
  });

  it("does not fire when total search-term spend is below MIN_TOTAL", () => {
    const records = [
      { name: "waste 1", spend: 25, clicks: 12, conversions: 0 },
      { name: "waste 2", spend: 25, clicks: 12, conversions: 0 },
    ];
    expect(rule.eval(baseCtx(records))).toBeNull();
  });

  it("ignores terms below MIN_SPEND_PER_TERM ($20)", () => {
    const records = [
      ...Array.from({ length: 50 }, (_, i) => ({
        name: `good ${i}`,
        spend: 20,
        clicks: 5,
        conversions: 1,
      })),
      { name: "noise 1", spend: 19.99, clicks: 30, conversions: 0 },
      { name: "noise 2", spend: 19.99, clicks: 30, conversions: 0 },
    ];
    expect(rule.eval(baseCtx(records))).toBeNull();
  });

  it("ignores terms below MIN_CLICKS_PER_TERM (10) — insufficient signal", () => {
    const records = [
      ...Array.from({ length: 50 }, (_, i) => ({
        name: `good ${i}`,
        spend: 20,
        clicks: 5,
        conversions: 1,
      })),
      { name: "untrustworthy 1", spend: 50, clicks: 9, conversions: 0 },
      { name: "untrustworthy 2", spend: 50, clicks: 9, conversions: 0 },
    ];
    expect(rule.eval(baseCtx(records))).toBeNull();
  });

  it("returns null when no search_term records exist", () => {
    expect(rule.eval(baseCtx([]))).toBeNull();
  });

  it("provides top-N examples sorted by spend descending", () => {
    const records = [
      ...Array.from({ length: 10 }, (_, i) => ({
        name: `good ${i}`,
        spend: 50,
        clicks: 5,
        conversions: 2,
      })),
      { name: "low waste", spend: 25, clicks: 15, conversions: 0 },
      { name: "high waste", spend: 80, clicks: 30, conversions: 0 },
      { name: "mid waste", spend: 50, clicks: 20, conversions: 0 },
    ];
    const result = rule.eval(baseCtx(records));
    expect(result.evidence.examples[0].term).toBe("high waste");
    expect(result.evidence.examples[0].spend).toBe(80);
    expect(result.evidence.examples[1].term).toBe("mid waste");
  });

  it("includes recovery line with 80% recovery factor", () => {
    const records = [
      ...Array.from({ length: 5 }, (_, i) => ({
        name: `good ${i}`,
        spend: 80,
        clicks: 5,
        conversions: 2,
      })),
      { name: "waste", spend: 100, clicks: 30, conversions: 0 },
    ];
    const result = rule.eval(baseCtx(records));
    expect(result).not.toBeNull();
    expect(result.estimatedImpact).toContain("80%");
    // 80% of $100 = $80
    expect(result.estimatedImpact).toContain("$80");
  });
});
