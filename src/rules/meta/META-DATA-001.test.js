import { describe, it, expect } from "vitest";
import rule from "./META-DATA-001.rule.js";
import {
  buildContext,
  buildContextWithNoMetaData,
} from "../__fixtures__/contextBuilders.js";

describe("META-DATA-001", () => {
  it("fires when no Meta records are present", () => {
    const result = rule.eval(buildContextWithNoMetaData());
    expect(result).not.toBeNull();
    expect(result.ruleId).toBe("DATA-001");
    expect(result.severity).toBe("CRITICAL");
    expect(result.platform).toBe("META");
    expect(result.evidence).toEqual({ uploadedRows: 0 });
  });

  it("does not fire when Meta records exist", () => {
    const result = rule.eval(buildContext());
    expect(result).toBeNull();
  });

  it("uses legacyRuleId 'DATA-001' for backward-compat finding emission", () => {
    expect(rule.legacyRuleId).toBe("DATA-001");
  });
});
