import { describe, it, expect } from "vitest";
import { runDeepAuditForAudit } from "./deepAudit.service.js";

const completedAudit = {
  id: "aud1",
  organizationId: "org1",
  status: "COMPLETED",
  selectedPlatforms: ["META"],
  businessProfileSnapshot: { sectionA: {} },
  normalizedDataset: { summary: { totals: {} }, data: { platforms: {} } },
  intakeResponses: [],
  ruleFindings: [{ id: "f1", ruleId: "CRE-003", severity: "HIGH" }],
  adAccount: { name: "X" },
  aiReport: null,
};

// Minimal injected deps. Each test overrides what it needs.
const baseDeps = (overrides = {}) => {
  const upserts = [];
  const records = [];
  return {
    upserts,
    records,
    deps: {
      prisma: {
        audit: { findFirst: async () => completedAudit },
        deepAuditReport: { upsert: async (args) => upserts.push(args) },
      },
      fetchPriors: async () => [],
      buildContext: () => ({ evidencePacket: {} }),
      generateStandard: async () => ({
        output: { executiveSummary: ["a", "b"] },
        provider: "gemini",
        model: "gemini-flash-latest",
      }),
      runLoop: async () => ({
        mode: "deep",
        report: { headline: "h", rootCause: "r", confidence: "high", recommendations: [{ action: "x" }] },
        reasoningTrace: [{ tool: "decomposeKpi" }],
        usage: { inputTokens: 100, outputTokens: 50 },
        reason: undefined,
      }),
      record: async (r) => records.push(r),
      readiness: () => ({ mode: "READY" }),
      model: "claude-opus-4-8",
      ...overrides,
    },
  };
};

describe("runDeepAuditForAudit", () => {
  it("throws notFound when the audit does not exist", async () => {
    const { deps } = baseDeps({
      prisma: { audit: { findFirst: async () => null }, deepAuditReport: { upsert: async () => {} } },
    });
    await expect(
      runDeepAuditForAudit({ auditId: "missing", organizationId: "org1" }, deps)
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("throws badRequest when the deterministic audit hasn't run", async () => {
    const { deps } = baseDeps({
      prisma: {
        audit: { findFirst: async () => ({ ...completedAudit, status: "DRAFT", ruleFindings: [] }) },
        deepAuditReport: { upsert: async () => {} },
      },
    });
    await expect(
      runDeepAuditForAudit({ auditId: "aud1", organizationId: "org1" }, deps)
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("returns the deep report, records usage, and persists it", async () => {
    const { deps, upserts, records } = baseDeps();
    const out = await runDeepAuditForAudit({ auditId: "aud1", organizationId: "org1" }, deps);

    expect(out.mode).toBe("deep");
    expect(out.report.headline).toBe("h");
    expect(out.reasoningTrace).toHaveLength(1);

    // AiUsage recorded for the deep loop.
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      purpose: "deep_audit",
      provider: "anthropic",
      model: "claude-opus-4-8",
      inputTokens: 100,
      outputTokens: 50,
      status: "SUCCESS",
    });

    // Persisted via upsert keyed on auditId.
    expect(upserts).toHaveLength(1);
    expect(upserts[0].where).toEqual({ auditId: "aud1" });
    expect(upserts[0].create.mode).toBe("deep");
  });

  it("persists + records ERROR status on the error-fallback path", async () => {
    const { deps, upserts, records } = baseDeps({
      runLoop: async () => ({
        mode: "fallback",
        report: { executiveSummary: ["a", "b"] },
        reasoningTrace: [],
        usage: { inputTokens: 10, outputTokens: 0 },
        reason: "error:api down",
      }),
    });
    const out = await runDeepAuditForAudit({ auditId: "aud1", organizationId: "org1" }, deps);

    expect(out.mode).toBe("fallback");
    expect(records[0].status).toBe("ERROR");
    expect(records[0].errorMessage).toMatch(/^error:api down/);
    expect(upserts[0].update.mode).toBe("fallback");
  });

  it("still returns the result when persistence is unavailable (unmigrated DB)", async () => {
    const { deps } = baseDeps({
      prisma: { audit: { findFirst: async () => completedAudit } }, // no deepAuditReport
    });
    const out = await runDeepAuditForAudit({ auditId: "aud1", organizationId: "org1" }, deps);
    expect(out.mode).toBe("deep"); // no throw despite missing table
  });
});
