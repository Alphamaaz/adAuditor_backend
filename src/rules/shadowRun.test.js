import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const ORIGINAL_FLAG = process.env.RULE_ENGINE_DUAL_WRITE;

// Mock the prisma module BEFORE importing shadowRun.service.js
vi.mock("../lib/prisma.js", () => {
  const createMany = vi.fn().mockResolvedValue({ count: 0 });
  return {
    prisma: {
      ruleExecution: {
        createMany,
      },
    },
    __mocks: { createMany },
  };
});

const { runShadowRules } = await import("./shadowRun.service.js");
const prismaModule = await import("../lib/prisma.js");

describe("shadowRun", () => {
  beforeEach(() => {
    prismaModule.prisma.ruleExecution.createMany.mockClear();
  });

  afterEach(() => {
    if (ORIGINAL_FLAG === undefined) {
      delete process.env.RULE_ENGINE_DUAL_WRITE;
    } else {
      process.env.RULE_ENGINE_DUAL_WRITE = ORIGINAL_FLAG;
    }
  });

  it("returns skipped=true when RULE_ENGINE_DUAL_WRITE is unset", async () => {
    delete process.env.RULE_ENGINE_DUAL_WRITE;
    const result = await runShadowRules({
      audit: makeAudit(),
      planTier: "free",
    });
    expect(result.enabled).toBe(false);
    expect(result.skipped).toBe(true);
    expect(prismaModule.prisma.ruleExecution.createMany).not.toHaveBeenCalled();
  });

  it("returns skipped=true when flag is 'false'", async () => {
    process.env.RULE_ENGINE_DUAL_WRITE = "false";
    const result = await runShadowRules({
      audit: makeAudit(),
      planTier: "free",
    });
    expect(result.enabled).toBe(false);
  });

  it("runs orchestrator and persists telemetry when flag is true", async () => {
    process.env.RULE_ENGINE_DUAL_WRITE = "true";
    const result = await runShadowRules({
      audit: makeAudit(),
      planTier: "free",
    });
    expect(result.enabled).toBe(true);
    expect(result.skipped).toBe(false);
    expect(result.totalRules).toBeGreaterThan(0);
    expect(prismaModule.prisma.ruleExecution.createMany).toHaveBeenCalledTimes(1);
  });

  it("never throws when prisma persistence fails (fail-safe contract)", async () => {
    process.env.RULE_ENGINE_DUAL_WRITE = "true";
    prismaModule.prisma.ruleExecution.createMany.mockRejectedValueOnce(
      new Error("simulated DB outage")
    );
    const result = await runShadowRules({
      audit: makeAudit(),
      planTier: "free",
    });
    expect(result.error).toContain("simulated DB outage");
    expect(result.enabled).toBe(true);
    // Must not have re-thrown
  });

  it("never throws when audit shape is invalid (fail-safe contract)", async () => {
    process.env.RULE_ENGINE_DUAL_WRITE = "true";
    const result = await runShadowRules({
      audit: { id: "x", selectedPlatforms: ["INVALID"] },
      planTier: "free",
    });
    expect(result.error).toBeTruthy();
    // Must not have re-thrown
  });

  it("reports timing breakdown when enabled", async () => {
    process.env.RULE_ENGINE_DUAL_WRITE = "true";
    const result = await runShadowRules({
      audit: makeAudit(),
      planTier: "free",
    });
    expect(result.contextBuildMs).toBeGreaterThanOrEqual(0);
    expect(result.evaluateMs).toBeGreaterThanOrEqual(0);
    expect(result.persistMs).toBeGreaterThanOrEqual(0);
    expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
  });
});

function makeAudit() {
  return {
    id: "aud_shadow_1",
    selectedPlatforms: ["META"],
    dataSource: "MANUAL_UPLOAD",
    businessProfileSnapshot: { sectionA: {}, sectionB: {}, sectionC: {} },
    intakeResponses: [{ section: "PLATFORM_META", answers: {} }],
    uploadReadiness: { mode: "FULL" },
    normalizedDataset: {
      summary: {
        totals: {},
        platforms: { META: { uploadedFiles: 1, rowCount: 1, spend: 100 } },
      },
      data: {
        platforms: {
          META: {
            records: [{ level: "campaign", name: "Test", spend: 100 }],
          },
        },
      },
    },
  };
}
