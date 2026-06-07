import { describe, it, expect } from "vitest";
import rule from "./META-CRE-001.rule.js";
import {
  buildContext,
  buildContextWithMetaAnswers,
  buildContextWithNoMetaData,
} from "../__fixtures__/contextBuilders.js";

describe("META-CRE-001", () => {
  it("fires when M8 contains 'monthly'", () => {
    const result = rule.eval(buildContextWithMetaAnswers({ M8: "We refresh monthly" }));
    expect(result).not.toBeNull();
    expect(result.ruleId).toBe("CRE-001");
    expect(result.platform).toBe("META");
    expect(result.severity).toBe("HIGH");
    expect(result.category).toBe("Creative Performance");
    expect(result.evidence).toEqual({ M8: "We refresh monthly" });
  });

  it("fires when M8 contains 'rarely'", () => {
    const result = rule.eval(buildContextWithMetaAnswers({ M8: "rarely refresh" }));
    expect(result).not.toBeNull();
  });

  it("does not fire when M8 indicates weekly refresh", () => {
    expect(rule.eval(buildContextWithMetaAnswers({ M8: "weekly" }))).toBeNull();
  });

  it("does not fire when M8 is unset", () => {
    expect(rule.eval(buildContext())).toBeNull();
  });

  it("does not fire when no Meta records are present", () => {
    const ctx = buildContextWithNoMetaData({
      audit: { intakeResponses: [{ section: "PLATFORM_META", answers: { M8: "monthly" } }] },
    });
    expect(rule.eval(ctx)).toBeNull();
  });
});
