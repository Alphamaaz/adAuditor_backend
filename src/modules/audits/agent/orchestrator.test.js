import { describe, it, expect } from "vitest";
import { runDeepAudit } from "./orchestrator.js";

// Minimal but valid audit bundle so the deterministic tools return real output.
const audit = {
  id: "aud_x",
  adAccountId: "acc1",
  adAccount: { name: "X" },
  selectedPlatforms: ["META"],
  healthScore: 60,
  completedAt: "2026-06-03T00:00:00Z",
  businessProfileSnapshot: { sectionA: { businessType: "Lead Gen", targetCpa: 20 } },
  normalizedDataset: {
    summary: { totals: { spend: 2019, impressions: 51000, clicks: 2020, conversions: 64 } },
    data: {
      platforms: {
        META: {
          byDimension: {
            age: [
              { dimension: "age", segment: "25-34", spend: 729, clicks: 500, impressions: 20000, conversions: 25, results: 25 },
              { dimension: "age", segment: "45-54", spend: 206, clicks: 180, impressions: 12000, conversions: 0, results: 0 },
            ],
          },
        },
      },
    },
  },
  ruleFindings: [
    { ruleId: "CRE-003", platform: "META", severity: "HIGH", category: "Creative Performance", title: "x", estimatedImpact: "$1,200" },
  ],
};

const auditWithDeadKeywords = {
  ...audit,
  id: "aud_google_dead_keywords",
  selectedPlatforms: ["GOOGLE"],
  normalizedDataset: {
    summary: {
      totals: { spend: 43470, impressions: 100000, clicks: 3000, conversions: 270 },
      platforms: {
        GOOGLE: { spend: 43470, impressions: 100000, clicks: 3000, conversions: 270, currency: "PKR" },
      },
    },
    data: {
      platforms: {
        GOOGLE: {
          byLevel: {
            campaign: [
              { level: "campaign", name: "PMax", objective: "PERFORMANCE_MAX", spend: 35000, impressions: 70000, clicks: 2100, conversions: 240 },
            ],
            keyword: [
              { level: "keyword", keyword: "blue widgets", status: "ACTIVE", impressions: 0, spend: 0 },
              { level: "keyword", keyword: "red widgets", status: "ACTIVE", impressions: 0, spend: 0 },
              { level: "keyword", keyword: "green widgets", status: "ACTIVE", impressions: 0, spend: 0 },
              { level: "keyword", keyword: "yellow widgets", status: "ACTIVE", impressions: 0, spend: 0 },
              { level: "keyword", keyword: "white widgets", status: "ACTIVE", impressions: 0, spend: 0 },
            ],
          },
        },
      },
    },
  },
  ruleFindings: [
    {
      ruleId: "KW-010",
      platform: "GOOGLE",
      severity: "MEDIUM",
      category: "Keyword Strategy",
      title: "Many active Google keywords are getting zero impressions",
      estimatedImpact: "Zero-impression active keywords inflate account clutter.",
    },
  ],
};

const text = (t) => ({ type: "text", text: t });
const toolUse = (id, name, input) => ({ type: "tool_use", id, name, input });
const resp = (content, usage = { input_tokens: 100, output_tokens: 50 }) => ({
  content,
  stopReason: "tool_use",
  usage,
});

// Scripted fake LLM client — returns pre-baked responses in order and records
// the args (so tests can assert tool_choice). Exhaustion → an end_turn with no
// tools, which the orchestrator handles without looping forever.
const scripted = (responses) => {
  const calls = [];
  let i = 0;
  return {
    calls,
    async createMessage(args) {
      calls.push(args);
      const r = responses[i] ?? { content: [], stopReason: "end_turn", usage: {} };
      i += 1;
      return r;
    },
  };
};

const REPORT = {
  headline: "Creative clickability is the bottleneck",
  rootCause: "CTR is the lever vs the better peer, not CPM",
  confidence: "high",
  drivers: "decomposeKpi: CTR dominant driver",
  recommendations: [{ action: "Refresh creative", rationale: "low CTR", estimatedImpact: "$X" }],
};

describe("runDeepAudit", () => {
  it("hypothesize → test → forced disconfirm → conclude → deep report", async () => {
    const client = scripted([
      resp([text("Hypothesis: CPR is CTR-driven."), toolUse("t1", "decomposeKpi", { kpi: "CPR" })]),
      resp([toolUse("t2", "analyzeSegments", {})]), // the disconfirming check
      resp([toolUse("c1", "concludeAudit", REPORT)]),
    ]);

    const out = await runDeepAudit({ audit, priorAudits: [], llmClient: client });

    expect(out.mode).toBe("deep");
    expect(out.report.headline).toBe(REPORT.headline);
    expect(out.reasoningTrace).toHaveLength(2);
    expect(out.reasoningTrace[0]).toMatchObject({ tool: "decomposeKpi", phase: "test" });
    expect(out.reasoningTrace[1]).toMatchObject({ tool: "analyzeSegments", phase: "disconfirm" });
    // The disconfirmation step was forced via tool_choice on the 2nd call.
    expect(client.calls[1].toolChoice).toEqual({ type: "any" });
    expect(out.usage.toolCalls).toBe(2);
  });

  it("rejects a premature conclusion until a disconfirming check has run", async () => {
    const client = scripted([
      resp([toolUse("t1", "decomposeKpi", { kpi: "CPR" })]),
      resp([toolUse("c1", "concludeAudit", REPORT)]), // premature — must be rejected
      resp([toolUse("t2", "analyzeSegments", {})]), // now the real disconfirm
      resp([toolUse("c2", "concludeAudit", REPORT)]), // accepted
    ]);

    const out = await runDeepAudit({ audit, priorAudits: [], llmClient: client });

    expect(out.mode).toBe("deep");
    expect(out.reasoningTrace).toHaveLength(2);
    expect(client.calls.length).toBe(4); // proves the premature attempt was bounced
  });

  it("requires campaign-type analysis before concluding when KW-010 is present", async () => {
    const client = scripted([
      resp([toolUse("t1", "getEvidencePacket", {})]),
      resp([toolUse("t2", "decomposeKpi", { kpi: "CPA" })]),
      resp([toolUse("c1", "concludeAudit", REPORT)]), // rejected: KW-010 needs campaign-type check
      resp([toolUse("t3", "analyzeCampaignTypes", {})]),
      resp([toolUse("c2", "concludeAudit", REPORT)]),
    ]);

    const out = await runDeepAudit({
      audit: auditWithDeadKeywords,
      priorAudits: [],
      llmClient: client,
    });

    expect(out.mode).toBe("deep");
    expect(out.reasoningTrace.map((step) => step.tool)).toEqual([
      "getEvidencePacket",
      "decomposeKpi",
      "analyzeCampaignTypes",
    ]);
    expect(client.calls.length).toBe(5);
  });

  it("degrades to fallback when the token budget is exceeded", async () => {
    const client = scripted([
      resp([toolUse("t1", "decomposeKpi", { kpi: "CPR" })], { output_tokens: 200 }),
      resp([toolUse("t2", "analyzeSegments", {})], { output_tokens: 200 }),
    ]);

    const out = await runDeepAudit({ audit, priorAudits: [], llmClient: client, tokenBudget: 100 });

    expect(out.mode).toBe("fallback");
    expect(out.reason).toBe("budget_exceeded");
  });

  it("degrades to fallback (using the injected generator) when validation fails", async () => {
    const client = scripted([
      resp([toolUse("t1", "decomposeKpi", { kpi: "CPR" })]),
      resp([toolUse("t2", "analyzeSegments", {})]),
      resp([toolUse("c1", "concludeAudit", { headline: "x" })]), // invalid: no recommendations
    ]);
    const fallback = async ({ reason }) => ({ mode: "fallback", report: { headline: "standard" }, reason });

    const out = await runDeepAudit({ audit, priorAudits: [], llmClient: client, fallback });

    expect(out.mode).toBe("fallback");
    expect(out.report.headline).toBe("standard"); // the standard single-shot path ran
    expect(out.reason).toMatch(/^validation_failed/);
  });

  it("degrades to fallback when the LLM call throws", async () => {
    const client = { calls: [], async createMessage() { throw new Error("api down"); } };

    const out = await runDeepAudit({ audit, priorAudits: [], llmClient: client });

    expect(out.mode).toBe("fallback");
    expect(out.reason).toMatch(/^error:/);
    expect(out.reasoningTrace).toHaveLength(0);
  });

  it("forces a conclusion once the tool-call cap is hit", async () => {
    const client = scripted([
      resp([toolUse("t1", "decomposeKpi", { kpi: "CPR" })]),
      resp([toolUse("t2", "analyzeSegments", {})]),
      resp([toolUse("c1", "concludeAudit", REPORT)]),
    ]);

    const out = await runDeepAudit({ audit, priorAudits: [], llmClient: client, maxToolCalls: 1 });

    // After 1 tool call the loop forces conclude; the model obliges → deep report.
    expect(out.mode).toBe("deep");
    expect(client.calls.some((c) => c.toolChoice && c.toolChoice.name === "concludeAudit")).toBe(true);
  });
});
