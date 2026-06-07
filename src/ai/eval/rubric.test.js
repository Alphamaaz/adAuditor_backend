import { describe, it, expect } from "vitest";
import { scoreReport } from "./rubric.js";
import fixtures from "./golden/index.js";
import { buildAiAuditContext } from "../../modules/audits/aiContext.service.js";

const scoreFixtureReference = (fixture) => {
  const context = buildAiAuditContext(fixture.audit, {
    priorAudits: fixture.priorAudits || [],
  });
  return scoreReport({
    output: fixture.referenceOutput,
    packet: context.evidencePacket,
    findings: fixture.audit.ruleFindings || [],
    expected: fixture.expected,
  });
};

describe("eval rubric — golden reference outputs", () => {
  for (const fixture of fixtures) {
    it(`"${fixture.name}" reference output passes the rubric`, () => {
      const result = scoreFixtureReference(fixture);
      if (!result.pass) {
        // Surface failures for debugging when this breaks.
        // eslint-disable-next-line no-console
        console.error(fixture.name, result.failures);
      }
      expect(result.pass).toBe(true);
      expect(result.total).toBeGreaterThanOrEqual(0.8);
    });
  }
});

describe("eval rubric — catches bad output", () => {
  const good = fixtures[0];
  const baseContext = () =>
    buildAiAuditContext(good.audit, { priorAudits: [] }).evidencePacket;

  it("fails on an invented dollar figure (factuality hard gate)", () => {
    const output = JSON.parse(JSON.stringify(good.referenceOutput));
    output.executiveSummary[0] = "You are wasting $99,999 per month.";
    const result = scoreReport({
      output,
      packet: baseContext(),
      findings: good.audit.ruleFindings,
      expected: good.expected,
    });
    expect(result.scores.factuality).toBe(0);
    expect(result.pass).toBe(false);
  });

  it("fails on an invented ruleId (ruleId hard gate)", () => {
    const output = JSON.parse(JSON.stringify(good.referenceOutput));
    output.topPriorities[0].ruleId = "MADE-UP-001";
    const result = scoreReport({
      output,
      packet: baseContext(),
      findings: good.audit.ruleFindings,
      expected: good.expected,
    });
    expect(result.scores.ruleIdCorrectness).toBe(0);
    expect(result.pass).toBe(false);
  });

  it("fails on an unknown sourceRuleId (source hard gate)", () => {
    const output = JSON.parse(JSON.stringify(good.referenceOutput));
    output.clientReadyRecommendations[0].sourceRuleIds = ["GHOST-999"];
    const result = scoreReport({
      output,
      packet: baseContext(),
      findings: good.audit.ruleFindings,
      expected: good.expected,
    });
    expect(result.scores.sourceRuleIds).toBe(0);
    expect(result.pass).toBe(false);
  });

  it("fails on a forbidden invented number", () => {
    const output = JSON.parse(JSON.stringify(good.referenceOutput));
    output.executiveSummary[1] += " Also you lost $12,345 somewhere.";
    const result = scoreReport({
      output,
      packet: baseContext(),
      findings: good.audit.ruleFindings,
      expected: good.expected,
    });
    // 12345 is in the fixture's forbiddenNumbers AND not in evidence → both gates fire.
    expect(result.pass).toBe(false);
  });
});
