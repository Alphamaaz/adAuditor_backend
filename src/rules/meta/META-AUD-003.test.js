import { describe, it, expect } from "vitest";
import rule from "./META-AUD-003.rule.js";
import {
  buildContext,
  buildContextWithMetaAnswers,
  buildContextWithNoMetaData,
} from "../__fixtures__/contextBuilders.js";

describe("META-AUD-003", () => {
  it("fires when M5 is 'no'", () => {
    const result = rule.eval(buildContextWithMetaAnswers({ M5: "no" }));
    expect(result).not.toBeNull();
    expect(result.ruleId).toBe("AUD-003");
    expect(result.platform).toBe("META");
    expect(result.severity).toBe("HIGH");
    expect(result.category).toBe("Retargeting Coverage");
  });

  it("does not fire when M5 is 'yes'", () => {
    const result = rule.eval(buildContextWithMetaAnswers({ M5: "yes" }));
    expect(result).toBeNull();
  });

  it("does not trigger on 'not at all' false-positive (word-boundary check)", () => {
    const result = rule.eval(buildContextWithMetaAnswers({ M5: "not at all" }));
    expect(result).toBeNull();
  });

  it("does not fire when there are no Meta records", () => {
    const ctx = buildContextWithNoMetaData({
      audit: { intakeResponses: [{ section: "PLATFORM_META", answers: { M5: "no" } }] },
    });
    expect(rule.eval(ctx)).toBeNull();
  });

  it("does not fire when M5 is unset", () => {
    expect(rule.eval(buildContext())).toBeNull();
  });
});
