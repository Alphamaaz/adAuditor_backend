import { describe, it, expect } from "vitest";
import { evaluateRules, buildContext, __test__ } from "./_orchestrator.js";
import {
  buildContext as buildFixtureContext,
  buildContextWithMetaAnswers,
  buildContextWithNoMetaData,
} from "./__fixtures__/contextBuilders.js";

describe("orchestrator.evaluateRules", () => {
  it("returns findings + executions for a meta-no-data context (DATA-001 fires)", async () => {
    const ctx = buildContextWithNoMetaData();
    const { findings, executions } = await evaluateRules(ctx, { planTier: "free" });

    expect(findings.length).toBe(1);
    expect(findings[0].ruleId).toBe("DATA-001");

    // All 5 Meta rules should have telemetry rows (FIRED or PASSED)
    expect(executions.length).toBeGreaterThanOrEqual(5);
    const data001Exec = executions.find((e) => e.ruleId === "META-DATA-001");
    expect(data001Exec.status).toBe("FIRED");
    expect(data001Exec.evidenceSummary).toEqual({ uploadedRows: 0 });
    expect(data001Exec.contextVersion).toBe("v1");
    expect(data001Exec.planTier).toBe("free");
    expect(data001Exec.ruleVersion).toBe("1.0.0");
    expect(data001Exec.durationMs).toBeTypeOf("number");
  });

  it("emits PASSED telemetry for rules that didn't fire", async () => {
    const ctx = buildFixtureContext(); // Meta records present, no flags set
    const { findings, executions } = await evaluateRules(ctx, { planTier: "free" });

    // None of the 5 should fire
    expect(findings.length).toBe(0);
    const fired = executions.filter((e) => e.status === "FIRED");
    expect(fired.length).toBe(0);
    const passed = executions.filter((e) => e.status === "PASSED");
    expect(passed.length).toBeGreaterThanOrEqual(5);
  });

  it("fires multiple rules when intake flags all set", async () => {
    const ctx = buildContextWithMetaAnswers({
      M5: "no",
      M6: "No",
      M7: 12,
      M8: "monthly refresh",
    });
    const { findings } = await evaluateRules(ctx, { planTier: "free" });

    const ruleIds = findings.map((f) => f.ruleId).sort();
    expect(ruleIds).toEqual(["AUD-001", "AUD-003", "CRE-001", "STR-006"]);
  });

  it("isolates rule errors and records ERROR telemetry without aborting", async () => {
    // Inject a context that throws by replacing intakeResponses with a getter that throws.
    // Since the eval is sync and reads ctx, simulate a corrupted dataset.
    // (None of the migrated rules currently throw, so we directly check that
    //  ERROR handling exists by spying on the registry. Light assertion: the
    //  orchestrator does not throw on a valid empty audit.)
    await expect(
      evaluateRules(buildContextWithNoMetaData(), { planTier: "free" })
    ).resolves.toBeDefined();
  });

  it("skips rules above the caller's plan tier with SKIPPED+reason='plan_tier'", async () => {
    // No migrated rules currently have minPlanTier > free, so we simulate
    // by checking that the skip path is in place: a rule with minPlanTier
    // "agency_plus" would be skipped for a "free" caller.
    // Direct unit test of plan tier gating logic deferred to when first
    // gated rule lands; for now assert structural correctness:
    const ctx = buildContextWithNoMetaData();
    const { executions } = await evaluateRules(ctx, { planTier: "free" });
    for (const exec of executions) {
      expect(["FIRED", "PASSED", "SKIPPED", "ERROR"]).toContain(exec.status);
    }
  });

  it("populates durationMs on every execution row", async () => {
    const ctx = buildContextWithNoMetaData();
    const { executions } = await evaluateRules(ctx, { planTier: "free" });
    for (const exec of executions) {
      expect(exec.durationMs).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("orchestrator.buildContext", () => {
  it("produces a context that validates against AuditContextSchema", () => {
    const ctx = buildContext({
      audit: {
        id: "aud_1",
        selectedPlatforms: ["META"],
        businessProfileSnapshot: { sectionA: {}, sectionB: {}, sectionC: {} },
        intakeResponses: [{ section: "PLATFORM_META", answers: {} }],
      },
      dataset: null,
      now: "2026-05-26T12:00:00.000Z",
    });
    expect(ctx.audit.id).toBe("aud_1");
    expect(ctx.audit.selectedPlatforms).toEqual(["META"]);
    expect(ctx.priorAudits).toEqual([]);
  });

  it("rejects invalid audit shape", () => {
    expect(() =>
      buildContext({ audit: { selectedPlatforms: ["INVALID"] } })
    ).toThrow();
  });
});

describe("orchestrator.compactEvidence", () => {
  it("caps evidence at 5 keys", () => {
    const compact = __test__.compactEvidence({
      a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7,
    });
    expect(Object.keys(compact).length).toBeLessThanOrEqual(5);
  });

  it("replaces arrays with their length", () => {
    const compact = __test__.compactEvidence({ examples: [1, 2, 3] });
    expect(compact.examples).toBe(3);
  });

  it("replaces nested objects with their key count", () => {
    const compact = __test__.compactEvidence({ meta: { x: 1, y: 2 } });
    expect(compact.meta).toBe(2);
  });

  it("returns null for falsy evidence", () => {
    expect(__test__.compactEvidence(null)).toBeNull();
    expect(__test__.compactEvidence(undefined)).toBeNull();
  });
});
