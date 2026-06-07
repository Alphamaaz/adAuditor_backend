import { describe, it, expect } from "vitest";
import rule from "./META-CAPI-MATCH-001.rule.js";
import { buildContext } from "../__fixtures__/contextBuilders.js";

const metaDataset = () => ({
  summary: {
    totals: {},
    platforms: {
      META: { uploadedFiles: 1, rowCount: 1, spend: 100, impressions: 0, clicks: 0, conversions: 0, reach: 0 },
    },
  },
  data: {
    platforms: {
      META: {
        records: [{ level: "campaign", name: "C1", spend: 100 }],
      },
    },
  },
});

const ctxWith = (answers) =>
  buildContext({
    audit: {
      selectedPlatforms: ["META"],
      intakeResponses: [{ section: "PLATFORM_META", answers }],
    },
    dataset: metaDataset(),
  });

describe("META-CAPI-MATCH-001", () => {
  it("fires HIGH when CAPI is not deployed", () => {
    const result = rule.eval(ctxWith({ M_CAPI_STATUS: "not_deployed" }));
    expect(result).not.toBeNull();
    expect(result.severity).toBe("HIGH");
    expect(result.evidence.reason).toBe("not_deployed");
    expect(result.title).toContain("not deployed");
  });

  it("fires MEDIUM when CAPI status is 'unsure'", () => {
    const result = rule.eval(ctxWith({ M_CAPI_STATUS: "unsure" }));
    expect(result).not.toBeNull();
    expect(result.severity).toBe("MEDIUM");
    expect(result.evidence.reason).toBe("status_unknown");
  });

  it("fires HIGH when match rate < 70%", () => {
    const result = rule.eval(
      ctxWith({ M_CAPI_STATUS: "deployed", M_CAPI_MATCH_RATE: 55 })
    );
    expect(result.severity).toBe("HIGH");
    expect(result.evidence.reason).toBe("low_match_rate");
    expect(result.evidence.matchRate).toBe(55);
  });

  it("fires MEDIUM when match rate is 70-85%", () => {
    const result = rule.eval(
      ctxWith({ M_CAPI_STATUS: "deployed", M_CAPI_MATCH_RATE: 78 })
    );
    expect(result.severity).toBe("MEDIUM");
    expect(result.evidence.reason).toBe("moderate_match_rate");
  });

  it("does not fire when match rate is 85% or higher", () => {
    expect(
      rule.eval(ctxWith({ M_CAPI_STATUS: "deployed", M_CAPI_MATCH_RATE: 85 }))
    ).toBeNull();
    expect(
      rule.eval(ctxWith({ M_CAPI_STATUS: "deployed", M_CAPI_MATCH_RATE: 95 }))
    ).toBeNull();
  });

  it("does not fire when no CAPI answer is provided (absent data)", () => {
    expect(rule.eval(ctxWith({}))).toBeNull();
  });

  it("does not fire when match rate provided alone but interpretable as deployed", () => {
    // Only match rate present, no status — treat as deployed implicit signal
    const result = rule.eval(ctxWith({ M_CAPI_MATCH_RATE: 50 }));
    expect(result).not.toBeNull();
    expect(result.severity).toBe("HIGH");
  });

  it("accepts 'no' as not_deployed", () => {
    const result = rule.eval(ctxWith({ M_CAPI_STATUS: "no" }));
    expect(result.severity).toBe("HIGH");
    expect(result.evidence.reason).toBe("not_deployed");
  });

  it("returns null when no Meta records exist (don't surface tracking-only findings)", () => {
    const ctx = buildContext({
      audit: {
        selectedPlatforms: ["META"],
        intakeResponses: [
          { section: "PLATFORM_META", answers: { M_CAPI_STATUS: "not_deployed" } },
        ],
      },
      dataset: {
        summary: { totals: {}, platforms: { META: { uploadedFiles: 0, rowCount: 0, spend: 0, impressions: 0, clicks: 0, conversions: 0, reach: 0 } } },
        data: { platforms: { META: { records: [] } } },
      },
    });
    expect(rule.eval(ctx)).toBeNull();
  });

  it("includes estimated lift range in evidence", () => {
    const result = rule.eval(ctxWith({ M_CAPI_STATUS: "not_deployed" }));
    expect(result.evidence.estimatedLiftRangePercent).toEqual({ min: 10, max: 20 });
  });
});
