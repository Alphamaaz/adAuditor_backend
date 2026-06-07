import { describe, it, expect } from "vitest";
import rule from "./META-STR-006.rule.js";
import {
  buildContext,
  buildContextWithMetaAnswers,
} from "../__fixtures__/contextBuilders.js";

describe("META-STR-006", () => {
  it("fires when average ads per ad set is below 3", () => {
    const result = rule.eval(buildContextWithMetaAnswers({ M7: 2 }));
    expect(result).not.toBeNull();
    expect(result.ruleId).toBe("STR-006");
    expect(result.severity).toBe("MEDIUM");
    expect(result.evidence).toEqual({ averageAdsPerAdSet: 2 });
  });

  it("fires when average ads per ad set is above 8", () => {
    const result = rule.eval(buildContextWithMetaAnswers({ M7: 12 }));
    expect(result).not.toBeNull();
    expect(result.evidence.averageAdsPerAdSet).toBe(12);
  });

  it("does not fire when M7 is within 3-8 range", () => {
    expect(rule.eval(buildContextWithMetaAnswers({ M7: 5 }))).toBeNull();
    expect(rule.eval(buildContextWithMetaAnswers({ M7: 3 }))).toBeNull();
    expect(rule.eval(buildContextWithMetaAnswers({ M7: 8 }))).toBeNull();
  });

  it("does not fire when M7 is unset or zero", () => {
    expect(rule.eval(buildContext())).toBeNull();
    expect(rule.eval(buildContextWithMetaAnswers({ M7: 0 }))).toBeNull();
  });

  it("does not fire when M7 is non-numeric", () => {
    expect(rule.eval(buildContextWithMetaAnswers({ M7: "many" }))).toBeNull();
  });
});
