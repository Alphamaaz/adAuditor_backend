/**
 * Rule orchestrator.
 *
 * Responsibilities:
 *   1. Build & validate ContextV1 from an audit
 *   2. Select rules from the registry (by platform, plan tier, budget)
 *   3. Execute rules in deterministic id order with per-rule error isolation
 *   4. Collect findings + per-rule RuleExecution telemetry rows
 *
 * It does NOT:
 *   - Write to the database directly. Callers persist findings + telemetry.
 *   - Compute scores. Scoring stays in the engine entry point.
 *
 * This keeps the orchestrator pure and unit-testable.
 */

import { performance } from "node:perf_hooks";

import { registry } from "./_registry.js";
import { AuditContextSchema, CONTEXT_VERSION } from "./schemas/context.schema.js";
import { PLAN_TIER_RANK } from "./schemas/rule.schema.js";

const FROZEN_NOW = () => new Date().toISOString();

const PLATFORM_BUDGETS = {
  free: { cheap: Infinity, moderate: 5, expensive: 0 },
  starter: { cheap: Infinity, moderate: Infinity, expensive: 5 },
  pro: { cheap: Infinity, moderate: Infinity, expensive: 20 },
  team: { cheap: Infinity, moderate: Infinity, expensive: 50 },
  agency: { cheap: Infinity, moderate: Infinity, expensive: Infinity },
  agency_plus: { cheap: Infinity, moderate: Infinity, expensive: Infinity },
};

/**
 * Build a ContextV1 from raw audit + dataset.
 *
 * The orchestrator's caller is expected to hydrate the audit with its
 * intakeResponses + businessProfileSnapshot before calling. Dataset is
 * the audit's NormalizedDataset (may be null for early-stage audits).
 */
export const buildContext = ({
  audit,
  dataset = null,
  priorAudits = [],
  benchmarks = {},
  now = FROZEN_NOW(),
}) => {
  const raw = {
    audit: {
      id: audit.id,
      selectedPlatforms: audit.selectedPlatforms ?? [],
      dataSource: audit.dataSource ?? null,
      businessProfileSnapshot: audit.businessProfileSnapshot ?? null,
      intakeResponses: (audit.intakeResponses ?? []).map((r) => ({
        section: r.section,
        answers: r.answers ?? {},
      })),
      uploadReadiness: audit.uploadReadiness ?? undefined,
    },
    dataset,
    priorAudits,
    benchmarks,
    now,
  };
  return AuditContextSchema.parse(raw);
};

const compactEvidence = (evidence) => {
  if (!evidence || typeof evidence !== "object") return null;
  const summary = {};
  let keyCount = 0;
  for (const [key, value] of Object.entries(evidence)) {
    if (keyCount >= 5) break;
    if (Array.isArray(value)) {
      summary[key] = value.length;
    } else if (value !== null && typeof value === "object") {
      summary[key] = Object.keys(value).length;
    } else {
      summary[key] = value;
    }
    keyCount += 1;
  }
  return summary;
};

const ruleAllowedByPlatform = (rule, selectedPlatforms) => {
  if (rule.platforms.includes("CROSS_PLATFORM")) return true;
  return rule.platforms.some((p) => selectedPlatforms.includes(p));
};

const ruleWithinBudget = (rule, budget, consumed) => {
  const cost = rule.costToEvaluate;
  const cap = budget?.[cost] ?? Infinity;
  const used = consumed[cost] ?? 0;
  return used < cap;
};

/**
 * Execute all eligible rules. Returns { findings, executions }.
 *
 * `executions` is a list of payloads matching RuleExecutionPayloadSchema —
 * caller is responsible for batched persistence.
 */
export const evaluateRules = async (ctx, { planTier = "free" } = {}) => {
  await registry.ensureLoaded();

  const allRules = registry.forContextVersion(CONTEXT_VERSION);
  const planRank = PLAN_TIER_RANK[planTier] ?? 0;
  const selectedPlatforms = ctx.audit.selectedPlatforms ?? [];
  const budget = PLATFORM_BUDGETS[planTier] ?? PLATFORM_BUDGETS.free;
  const consumedByCost = { cheap: 0, moderate: 0, expensive: 0 };

  // Two-pass: base rules first, compound rules last. Compound rules can read
  // accumulated findings via ctx.findings (frozen view).
  const baseRules = allRules.filter(
    (r) => !r.platforms.includes("CROSS_PLATFORM")
  );
  const compoundRules = allRules.filter((r) =>
    r.platforms.includes("CROSS_PLATFORM")
  );

  const findings = [];
  const executions = [];

  const runPass = (rules, extraCtx = ctx) => {
    for (const rule of rules) {
      if (rule.deprecated) continue;
      if (PLAN_TIER_RANK[rule.minPlanTier] > planRank) {
        executions.push({
          ruleId: rule.id,
          ruleVersion: rule.version,
          status: "SKIPPED",
          durationMs: 0,
          findingId: null,
          errorMessage: null,
          evidenceSummary: { reason: "plan_tier" },
          contextVersion: rule.contextVersion,
          planTier,
        });
        continue;
      }
      if (!ruleAllowedByPlatform(rule, selectedPlatforms)) continue;
      if (!ruleWithinBudget(rule, budget, consumedByCost)) {
        executions.push({
          ruleId: rule.id,
          ruleVersion: rule.version,
          status: "SKIPPED",
          durationMs: 0,
          findingId: null,
          errorMessage: null,
          evidenceSummary: { reason: "budget" },
          contextVersion: rule.contextVersion,
          planTier,
        });
        continue;
      }

      const start = performance.now();
      let finding = null;
      let errorMessage = null;
      try {
        finding = rule.eval(extraCtx);
      } catch (err) {
        errorMessage = err?.message ?? String(err);
      }
      const durationMs = Math.round(performance.now() - start);

      let status;
      if (errorMessage) status = "ERROR";
      else if (finding) status = "FIRED";
      else status = "PASSED";

      consumedByCost[rule.costToEvaluate] =
        (consumedByCost[rule.costToEvaluate] ?? 0) + 1;

      if (finding) findings.push(finding);

      executions.push({
        ruleId: rule.id,
        ruleVersion: rule.version,
        status,
        durationMs,
        findingId: null, // populated post-persistence if caller links them
        errorMessage,
        evidenceSummary: finding ? compactEvidence(finding.evidence) : null,
        contextVersion: rule.contextVersion,
        planTier,
      });
    }
  };

  runPass(baseRules);

  // Compound rules see a frozen findings array
  const compoundCtx = { ...ctx, findings: Object.freeze([...findings]) };
  runPass(compoundRules, compoundCtx);

  return { findings, executions };
};

export const __test__ = { compactEvidence, PLATFORM_BUDGETS };
