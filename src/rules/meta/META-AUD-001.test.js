import { describe, it, expect } from "vitest";
import rule from "./META-AUD-001.rule.js";
import {
  buildContext,
  buildContextWithMetaAnswers,
  buildContextWithNoMetaData,
} from "../__fixtures__/contextBuilders.js";

describe("META-AUD-001", () => {
  it("fires when M6 explicitly answered 'no'", () => {
    const result = rule.eval(buildContextWithMetaAnswers({ M6: "No" }));
    expect(result).not.toBeNull();
    expect(result.ruleId).toBe("AUD-001");
    expect(result.severity).toBe("HIGH");
    expect(result.evidence).toEqual({ M6: "No" });
  });

  it("fires when M6 contains 'unsure'", () => {
    const result = rule.eval(buildContextWithMetaAnswers({ M6: "I'm unsure about this" }));
    expect(result).not.toBeNull();
    expect(result.ruleId).toBe("AUD-001");
  });

  it("does not fire when M6 is 'yes'", () => {
    const result = rule.eval(buildContextWithMetaAnswers({ M6: "Yes" }));
    expect(result).toBeNull();
  });

  it("does not trigger on 'Do not know' false-positive (word-boundary check)", () => {
    // Reproduces the legacy bug guarded by matchesWord: bare .includes("no")
    // would match "not", but matchesWord uses \bno\b so only standalone "no" hits.
    const result = rule.eval(buildContextWithMetaAnswers({ M6: "Do not know" }));
    expect(result).toBeNull();
  });

  it("does not fire when there are no Meta records (gated by DATA-001 precondition)", () => {
    const ctx = buildContextWithNoMetaData({
      audit: { intakeResponses: [{ section: "PLATFORM_META", answers: { M6: "No" } }] },
    });
    const result = rule.eval(ctx);
    expect(result).toBeNull();
  });

  it("does not fire when M6 is empty", () => {
    const result = rule.eval(buildContext());
    expect(result).toBeNull();
  });
});
