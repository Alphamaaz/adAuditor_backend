import { describe, it, expect } from "vitest";
import { DEEP_AUDIT_FIXTURES } from "./fixtures.js";
import { createDeepAuditTools } from "../tools.js";

/**
 * The golden fixtures are only meaningful if the deterministic substrate the
 * agent reasons over actually points at the stated root cause. If these pass,
 * then an honest tool-using model WILL reach the right answer — which is the
 * guarantee the live eval (run.js) then checks on the model itself.
 */
describe("Deep Audit golden fixtures — deterministic signal", () => {
  it("every fixture is well-formed", () => {
    const names = DEEP_AUDIT_FIXTURES.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length); // unique names
    for (const fx of DEEP_AUDIT_FIXTURES) {
      expect(fx.audit).toBeTruthy();
      expect(Array.isArray(fx.keywords) && fx.keywords.length).toBeTruthy();
      expect(fx.signal).toBeTruthy();
    }
  });

  for (const fx of DEEP_AUDIT_FIXTURES) {
    it(`${fx.name}: tools point at the expected root cause`, () => {
      const tools = createDeepAuditTools({ audit: fx.audit, priorAudits: fx.priorAudits });

      if (fx.signal.tool === "decomposeKpi") {
        const out = tools.decomposeKpi({ kpi: fx.kpi });
        expect(out.decomposition).toBeTruthy();
        expect(out.decomposition.dominantDriver).toBe(fx.signal.dominantDriver);
        // These cases hinge on a peer comparison — confirm the peer was used.
        expect(out.referenceSource.startsWith("peer:")).toBe(true);
      } else if (fx.signal.tool === "analyzeSegments") {
        const out = tools.analyzeSegments();
        expect(out.available).toBe(true);
        expect(out.headline.worst.segment).toBe(fx.signal.segment);
      } else {
        throw new Error(`Unknown signal tool: ${fx.signal.tool}`);
      }
    });
  }
});
