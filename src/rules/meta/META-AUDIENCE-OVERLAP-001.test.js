import { describe, it, expect } from "vitest";
import rule from "./META-AUDIENCE-OVERLAP-001.rule.js";
import { buildContext } from "../__fixtures__/contextBuilders.js";

const datasetWith = (adsets) => ({
  summary: {
    totals: {},
    platforms: {
      META: {
        uploadedFiles: 1,
        rowCount: adsets.length,
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
        records: adsets.map((a) => ({ level: "adset", ...a })),
        byLevel: { adset: adsets.map((a) => ({ level: "adset", ...a })) },
      },
    },
  },
});

const baseCtx = ({ answers = {}, adsets }) =>
  buildContext({
    audit: {
      selectedPlatforms: ["META"],
      intakeResponses: [
        { section: "PLATFORM_META", answers },
      ],
    },
    dataset: datasetWith(adsets),
  });

describe("META-AUDIENCE-OVERLAP-001", () => {
  it("fires with MEDIUM when 2 ad sets in one campaign show overlap signals", () => {
    const adsets = [
      { campaignName: "A", status: "ACTIVE", frequency: 4.0, spend: 200 },
      { campaignName: "A", status: "ACTIVE", frequency: 3.5, spend: 200 },
    ];
    const result = rule.eval(baseCtx({ adsets }));
    expect(result).not.toBeNull();
    expect(result.severity).toBe("MEDIUM");
    expect(result.evidence.campaignsAffected).toBe(1);
    expect(result.evidence.totalOverlappingAdSets).toBe(2);
  });

  it("fires with HIGH when 3+ ad sets overlap in a single campaign", () => {
    const adsets = [
      { campaignName: "A", status: "ACTIVE", frequency: 4.0, spend: 200 },
      { campaignName: "A", status: "ACTIVE", frequency: 3.5, spend: 200 },
      { campaignName: "A", status: "ACTIVE", frequency: 5.0, spend: 200 },
    ];
    const result = rule.eval(baseCtx({ adsets }));
    expect(result.severity).toBe("HIGH");
    expect(result.evidence.maxOverlapInOneCampaign).toBe(3);
  });

  it("escalates severity to HIGH when intake M12 confirms lookalike stacking", () => {
    const adsets = [
      { campaignName: "A", status: "ACTIVE", frequency: 4.0, spend: 200 },
      { campaignName: "A", status: "ACTIVE", frequency: 3.5, spend: 200 },
    ];
    const result = rule.eval(
      baseCtx({ adsets, answers: { M12: "yes" } })
    );
    expect(result.severity).toBe("HIGH");
    expect(result.evidence.signalSources).toContain("intake_M12_lookalikes");
  });

  it("escalates severity when intake M13 indicates stacked broad interests", () => {
    const adsets = [
      { campaignName: "A", status: "ACTIVE", frequency: 4.0, spend: 200 },
      { campaignName: "A", status: "ACTIVE", frequency: 3.5, spend: 200 },
    ];
    const result = rule.eval(
      baseCtx({ adsets, answers: { M13: "many stacked interests" } })
    );
    expect(result.severity).toBe("HIGH");
    expect(result.evidence.signalSources).toContain("intake_M13_interests");
  });

  it("does not fire when only intake signals are set but data shows no overlap", () => {
    // Intake-only is too weak to fire by itself.
    const adsets = [
      { campaignName: "A", status: "ACTIVE", frequency: 1.5, spend: 200 },
    ];
    const result = rule.eval(
      baseCtx({ adsets, answers: { M12: "yes", M13: "stacked" } })
    );
    expect(result).toBeNull();
  });

  it("ignores paused ad sets", () => {
    const adsets = [
      { campaignName: "A", status: "PAUSED", frequency: 5.0, spend: 200 },
      { campaignName: "A", status: "PAUSED", frequency: 5.0, spend: 200 },
    ];
    expect(rule.eval(baseCtx({ adsets }))).toBeNull();
  });

  it("ignores ad sets below MIN_ADSET_SPEND ($100)", () => {
    const adsets = [
      { campaignName: "A", status: "ACTIVE", frequency: 5.0, spend: 99 },
      { campaignName: "A", status: "ACTIVE", frequency: 5.0, spend: 50 },
    ];
    expect(rule.eval(baseCtx({ adsets }))).toBeNull();
  });

  it("ignores ad sets below OVERLAP_FREQ (3.0)", () => {
    const adsets = [
      { campaignName: "A", status: "ACTIVE", frequency: 2.9, spend: 200 },
      { campaignName: "A", status: "ACTIVE", frequency: 2.5, spend: 200 },
    ];
    expect(rule.eval(baseCtx({ adsets }))).toBeNull();
  });

  it("does not fire on single ad-set campaigns", () => {
    const adsets = [
      { campaignName: "A", status: "ACTIVE", frequency: 5.0, spend: 200 },
    ];
    expect(rule.eval(baseCtx({ adsets }))).toBeNull();
  });

  it("returns null when no Meta ad sets exist", () => {
    expect(rule.eval(baseCtx({ adsets: [] }))).toBeNull();
  });

  it("examples are sorted by spend descending", () => {
    const adsets = [
      // small campaign
      { campaignName: "B", status: "ACTIVE", frequency: 4.0, spend: 200 },
      { campaignName: "B", status: "ACTIVE", frequency: 4.0, spend: 200 },
      // big campaign
      { campaignName: "A", status: "ACTIVE", frequency: 4.0, spend: 1000 },
      { campaignName: "A", status: "ACTIVE", frequency: 4.0, spend: 1000 },
    ];
    const result = rule.eval(baseCtx({ adsets }));
    expect(result.evidence.examples[0].campaign).toBe("A");
    expect(result.evidence.examples[1].campaign).toBe("B");
  });
});
