/**
 * Dual-write shadow runner for the rule engine refactor.
 *
 * Runs the new orchestrator in parallel with the legacy engine, persists
 * RuleExecution telemetry rows, and returns a summary. The legacy engine
 * remains the source of truth for customer-facing findings.
 *
 * Gated by env var: RULE_ENGINE_DUAL_WRITE=true
 *
 * Fail-safe contract:
 *   - This function must never throw to its caller.
 *   - Any error is caught, logged, and reported in the returned summary.
 *   - The caller's audit completion must not depend on this function.
 *
 * Usage:
 *   import { runShadowRules } from "../rules/shadowRun.service.js";
 *   const summary = await runShadowRules({ audit, planTier, logger });
 */

import { performance } from "node:perf_hooks";

import { prisma } from "../lib/prisma.js";
import { buildContext, evaluateRules } from "./_orchestrator.js";

const SHADOW_ENABLED = () =>
  String(process.env.RULE_ENGINE_DUAL_WRITE || "").toLowerCase() === "true";

const safeWritePersistTelemetry = async ({ auditId, executions }) => {
  if (executions.length === 0) return { inserted: 0 };
  await prisma.ruleExecution.createMany({
    data: executions.map((exec) => ({
      auditId,
      ruleId: exec.ruleId,
      ruleVersion: exec.ruleVersion,
      status: exec.status,
      durationMs: exec.durationMs,
      findingId: exec.findingId ?? null,
      errorMessage: exec.errorMessage ?? null,
      evidenceSummary: exec.evidenceSummary ?? undefined,
      contextVersion: exec.contextVersion,
      planTier: exec.planTier,
    })),
  });
  return { inserted: executions.length };
};

/**
 * Runs the new orchestrator and persists its telemetry. Never throws.
 *
 * @param {object} args
 * @param {object} args.audit       Hydrated audit (intakeResponses + dataset).
 * @param {string} args.planTier    Plan tier slug (e.g. "free", "pro").
 * @returns {Promise<{enabled, skipped, error, totalRules, fired, passed, errored, skippedCount, totalDurationMs, persistedRows}>}
 */
export const runShadowRules = async ({ audit, planTier = "free" }) => {
  if (!SHADOW_ENABLED()) {
    return { enabled: false, skipped: true };
  }

  const summary = {
    enabled: true,
    skipped: false,
    error: null,
    totalRules: 0,
    fired: 0,
    passed: 0,
    errored: 0,
    skippedCount: 0,
    totalDurationMs: 0,
    persistedRows: 0,
    contextBuildMs: 0,
    evaluateMs: 0,
    persistMs: 0,
  };

  const start = performance.now();
  try {
    const ctxStart = performance.now();
    const ctx = buildContext({
      audit: {
        id: audit.id,
        selectedPlatforms: audit.selectedPlatforms ?? [],
        dataSource: audit.dataSource ?? null,
        businessProfileSnapshot: audit.businessProfileSnapshot ?? null,
        intakeResponses: audit.intakeResponses ?? [],
        uploadReadiness: audit.uploadReadiness ?? undefined,
      },
      dataset: audit.normalizedDataset ?? null,
      priorAudits: [],
      benchmarks: {},
    });
    summary.contextBuildMs = Math.round(performance.now() - ctxStart);

    const evalStart = performance.now();
    const { executions } = await evaluateRules(ctx, { planTier });
    summary.evaluateMs = Math.round(performance.now() - evalStart);

    summary.totalRules = executions.length;
    for (const exec of executions) {
      if (exec.status === "FIRED") summary.fired += 1;
      else if (exec.status === "PASSED") summary.passed += 1;
      else if (exec.status === "ERROR") summary.errored += 1;
      else if (exec.status === "SKIPPED") summary.skippedCount += 1;
    }

    const persistStart = performance.now();
    const { inserted } = await safeWritePersistTelemetry({
      auditId: audit.id,
      executions,
    });
    summary.persistMs = Math.round(performance.now() - persistStart);
    summary.persistedRows = inserted;
  } catch (err) {
    summary.error = err?.message ?? String(err);
    // eslint-disable-next-line no-console
    console.error(
      `[shadowRun] audit=${audit?.id} failed: ${summary.error}`
    );
  }
  summary.totalDurationMs = Math.round(performance.now() - start);
  return summary;
};

export const __test__ = { SHADOW_ENABLED };
