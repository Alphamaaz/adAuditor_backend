import { prisma } from "../lib/prisma.js";
import { runDeterministicAudit } from "../modules/audits/auditEngine.service.js";
import { calculateUploadReadiness } from "../modules/audits/uploadReadiness.service.js";
import { buildAiAuditContext } from "../modules/audits/aiContext.service.js";
import { generateAiAuditReport } from "../modules/audits/aiProvider.service.js";
import { runDeepAudit } from "../modules/audits/agent/orchestrator.js";
import { isDeepAuditEnabled, DEEP_AUDIT_MODEL } from "../modules/audits/agent/config.js";
import { runAnalyst } from "../modules/audits/analyst/analystRun.service.js";
import { verifyAnalystReport } from "../modules/audits/analyst/analystVerification.service.js";
import {
  isAnalystEnabled,
  ANALYST_MODEL,
  resolveAnalystModel,
} from "../modules/audits/analyst/analystConfig.js";
import {
  validateAiReportOutput,
  validateAiReportFactuality,
  validateRecommendationsNotGeneric,
} from "../modules/audits/aiReportValidation.service.js";
import { generateAuditPdfFile } from "../modules/audits/pdfReport.service.js";
import { fetchPreviousAudit } from "../modules/audits/auditHistory.service.js";
import {
  recordAuditRun,
  resolveEffectivePlan,
} from "../modules/plans/plan.resolver.js";
import {
  fetchRecentMemorySummaries,
  writeAuditMemorySummary,
} from "../modules/audits/memorySummary.service.js";
import { runShadowRules } from "../rules/shadowRun.service.js";
import {
  buildComparisonFindings,
  buildCurrentSnapshot,
} from "../modules/audits/comparisonFindings.service.js";
import {
  sumOrgAiCostUsd,
  sumGlobalAiCostUsd,
  recordAiUsage,
} from "../modules/audits/aiUsage.service.js";
import {
  FREE_PLAN_FALLBACK,
  resolveCurrentUsagePeriod,
} from "../modules/plans/plan.resolver.js";

/**
 * Returns true when org + global AI caps still have headroom.
 * Used by the worker before kicking off AI generation. Logs an event and
 * returns false when blocked — the deterministic report remains intact.
 */
const aiCapsHaveHeadroom = async ({
  organizationId,
  effectivePlan,
  subscription,
  auditId,
}) => {
  // Per-org monthly cap. Only apply the free-tier fallback cap when there is
  // no plan at all. Paid plans without an explicit cap have no per-org limit —
  // falling back to $0.50 would incorrectly block them once they exceed it.
  const orgCap = effectivePlan
    ? (effectivePlan.aiMonthlyUsdCap != null ? Number(effectivePlan.aiMonthlyUsdCap) : null)
    : FREE_PLAN_FALLBACK.aiMonthlyUsdCap;
  if (orgCap != null && Number.isFinite(orgCap)) {
    const { periodStart, periodEnd } = resolveCurrentUsagePeriod(subscription);
    const used = await sumOrgAiCostUsd({
      organizationId,
      since: periodStart,
      until: periodEnd,
    });
    if (used >= orgCap) {
      await logEvent(auditId, "AI_REPORT_CAP_REACHED", null, {
        scope: "org_monthly",
        capUsd: orgCap,
        usedUsd: Number(used.toFixed(2)),
      });
      return false;
    }
  }

  // Global daily cap.
  const globalCap = Number(process.env.AI_GLOBAL_DAILY_USD_CAP || 0);
  if (globalCap > 0) {
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const used = await sumGlobalAiCostUsd({ since: todayStart });
    if (used >= globalCap) {
      await logEvent(auditId, "AI_REPORT_CAP_REACHED", null, {
        scope: "global_daily",
        capUsd: globalCap,
        usedUsd: Number(used.toFixed(2)),
      });
      return false;
    }
  }
  return true;
};

const AI_REPORT_MAX_ATTEMPTS = 2;

const fullAuditInclude = {
  adAccount: true,
  intakeResponses: true,
  uploadedFiles: { orderBy: { createdAt: "desc" } },
  normalizedDataset: true,
  ruleFindings: { orderBy: { createdAt: "desc" } },
  aiReport: true,
  analystReport: true,
  pdfReports: { orderBy: { version: "desc" } },
  organization: { select: { brandingSettings: true } },
};

const loadAudit = (auditId) =>
  prisma.audit.findUnique({
    where: { id: auditId },
    include: fullAuditInclude,
  });

const logEvent = (auditId, type, message, metadata) =>
  prisma.auditEvent
    .create({
      data: { auditId, type, message, metadata },
    })
    .catch((error) => {
      // eslint-disable-next-line no-console
      console.error(`[auditPipeline] event log failed (${type})`, error.message);
    });

/**
 * Runs the deterministic engine, persists findings + a fallback AI record,
 * and updates audit status. Idempotent on retries — wipes prior findings
 * before re-creating.
 *
 * @param {object} args
 * @param {string} args.auditId
 * @param {string} args.organizationId  Used for usage counter increment.
 */
export const processRunAudit = async ({ auditId, organizationId }) => {
  const audit = await loadAudit(auditId);
  if (!audit) throw new Error(`Audit ${auditId} not found`);

  const subscription = await prisma.subscription.findUnique({
    where: { organizationId },
  });

  const uploadReadiness = calculateUploadReadiness(audit);
  const auditForEngine = { ...audit, uploadReadiness };

  let engineResult;
  try {
    engineResult = runDeterministicAudit(auditForEngine);
  } catch (error) {
    await prisma.audit.update({
      where: { id: auditId },
      data: { status: "FAILED" },
    });
    await logEvent(auditId, "AUDIT_RUN_FAILED", "Deterministic engine threw an error.", {
      error: error.message,
    });
    throw error;
  }

  // Peer + self-over-time comparison findings. Best-effort: missing prior
  // data must never fail an audit. First audit → priorSummaries empty → [].
  let comparisonFindings = [];
  try {
    const priorSummaries = await fetchRecentMemorySummaries({
      organizationId,
      excludeAuditId: auditId,
      limit: 10,
    });
    if (priorSummaries.length > 0) {
      const current = buildCurrentSnapshot({
        audit,
        scores: engineResult.scores,
        dataset: audit.normalizedDataset,
      });
      comparisonFindings = buildComparisonFindings({ current, priorSummaries });
    }
  } catch (cmpError) {
    // eslint-disable-next-line no-console
    console.error(`[auditPipeline] comparison findings failed (non-fatal): ${cmpError.message}`);
  }

  // Comparison findings are persisted for the UI + evidence packet, but they
  // do NOT alter the deterministic health score (scores reflect the rule
  // engine only). They are additive diagnostic context.
  const allFindings = [...engineResult.findings, ...comparisonFindings];

  await prisma.$transaction(async (tx) => {
    await tx.ruleFinding.deleteMany({ where: { auditId } });

    if (allFindings.length > 0) {
      await tx.ruleFinding.createMany({
        data: allFindings.map((finding) => ({
          auditId,
          ruleId: finding.ruleId,
          platform: finding.platform,
          severity: finding.severity,
          category: finding.category,
          title: finding.title,
          detail: finding.detail,
          evidence: finding.evidence,
          estimatedImpact: finding.estimatedImpact,
          fixSteps: finding.fixSteps,
        })),
      });
    }

    await tx.aiReport.upsert({
      where: { auditId },
      create: {
        auditId,
        provider: "deterministic",
        model: "rule-engine-v1",
        promptMeta: {
          aiGenerated: false,
          reason: "Deterministic fallback report generated before AI layer.",
          uploadReadiness,
        },
        output: engineResult.report,
      },
      update: {
        provider: "deterministic",
        model: "rule-engine-v1",
        promptMeta: {
          aiGenerated: false,
          reason: "Deterministic fallback report generated before AI layer.",
          uploadReadiness,
        },
        output: engineResult.report,
      },
    });

    await tx.audit.update({
      where: { id: auditId },
      data: {
        status: "PROCESSING",
        healthScore: engineResult.scores.overall,
        categoryScores: engineResult.scores,
      },
    });
  });

  await logEvent(auditId, "AUDIT_ENGINE_COMPLETED", "Deterministic audit engine completed. Awaiting AI deep audit.", {
    healthScore: engineResult.scores.overall,
    findingCount: engineResult.findings.length,
  });

  // Dual-write shadow run — telemetry-only. Behind RULE_ENGINE_DUAL_WRITE flag.
  // Fail-safe: never throws to here, never affects audit completion.
  try {
    const effectivePlan = await resolveEffectivePlan(organizationId);
    const planTier = effectivePlan?.plan?.slug ?? "free";
    const shadowSummary = await runShadowRules({
      audit: auditForEngine,
      planTier,
    });
    if (shadowSummary.enabled && !shadowSummary.skipped) {
      await logEvent(auditId, "RULE_ENGINE_SHADOW_RUN", null, shadowSummary);
    }
  } catch (shadowError) {
    // Defense in depth — runShadowRules already catches, but if somehow it
    // throws, we still must not fail the audit.
    await logEvent(auditId, "RULE_ENGINE_SHADOW_RUN_FAILED", null, {
      error: shadowError.message,
    });
  }

  // Memory summary writer — best-effort. Powers cross-audit AI context and
  // the score-trend chart on the dashboard.
  try {
    await writeAuditMemorySummary(auditId);
    await logEvent(auditId, "MEMORY_SUMMARY_WRITTEN", "Audit memory summary persisted.", null);
  } catch (memoryError) {
    await logEvent(auditId, "MEMORY_SUMMARY_FAILED", "Failed to persist audit memory summary.", {
      error: memoryError.message,
    });
  }

  // Usage counter increments AFTER the transaction commits — never charge
  // for failed audits. Failures here are non-fatal.
  try {
    await recordAuditRun(organizationId, subscription);
  } catch (usageError) {
    await logEvent(auditId, "USAGE_COUNTER_FAILED", "Failed to increment usage counter after audit run.", {
      error: usageError.message,
    });
  }

  // Always queue the AI/deep audit. The audit status stays PROCESSING until
  // the AI job completes — results are not surfaced to the user until then.
  // Dynamic import avoids a circular dep with auditQueue → auditPipeline.
  let aiAutoQueued = false;
  try {
    const { enqueueGenerateAiReport } = await import("../queues/auditQueue.js");
    await enqueueGenerateAiReport({ auditId });
    aiAutoQueued = true;
    await logEvent(
      auditId,
      "AI_REPORT_AUTO_QUEUED",
      "AI deep audit auto-queued. Audit completes after AI finishes.",
      {}
    );
  } catch (autoAiError) {
    // Queue failure: mark COMPLETED with deterministic fallback so the user
    // is never left stuck in PROCESSING indefinitely.
    await prisma.audit
      .update({
        where: { id: auditId },
        data: { status: "COMPLETED", completedAt: new Date() },
      })
      .catch(() => {});
    await logEvent(
      auditId,
      "AI_REPORT_AUTO_QUEUE_FAILED",
      "Failed to queue AI report; deterministic report is available.",
      { error: autoAiError.message }
    );
  }

  return {
    findings: engineResult.findings.length,
    score: engineResult.scores.overall,
    aiAutoQueued,
  };
};

const tryGenerateValidatedAiReport = async ({
  context,
  findings,
  auditId,
  organizationId,
}) => {
  const attempts = [];

  for (let attempt = 1; attempt <= AI_REPORT_MAX_ATTEMPTS; attempt += 1) {
    try {
      const generated = await generateAiAuditReport({
        context,
        auditId,
        organizationId,
        purpose: `audit_report_attempt_${attempt}`,
      });
      const validation = validateAiReportOutput({
        output: generated.output,
        findings,
      });

      if (validation.isValid) {
        // Customer-visible money must exist in verified evidence. A fabricated
        // amount consumes an attempt; repeated failure keeps the deterministic
        // report instead of publishing unsupported numbers.
        const factuality = validateAiReportFactuality({
          output: generated.output,
          verifiedNumbers: context?.evidencePacket?.verifiedNumbers || [],
        });
        if (!factuality.ok) {
          attempts.push({
            attempt,
            type: "FACTUALITY_FAILED",
            provider: generated.provider,
            model: generated.model,
            errors: factuality.warnings,
          });
          continue;
        }
        const genericCheck = validateRecommendationsNotGeneric({
          output: generated.output,
        });
        return {
          ok: true,
          attempt,
          report: generated,
          attempts,
          qualityWarnings: [...genericCheck.warnings],
        };
      }

      attempts.push({
        attempt,
        type: "VALIDATION_FAILED",
        provider: generated.provider,
        model: generated.model,
        errors: validation.errors,
      });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`[auditPipeline] AI report attempt ${attempt} failed:`, error?.message, error?.details);
      attempts.push({
        attempt,
        type: "PROVIDER_ERROR",
        message: error?.message,
        details: error?.details,
      });
    }
  }

  // eslint-disable-next-line no-console
  console.error(`[auditPipeline] All ${AI_REPORT_MAX_ATTEMPTS} AI report attempts failed:`, attempts);
  return { ok: false, attempts };
};

/**
 * Build a fact source map: which ruleIds support each AI top priority +
 * recommendation, and whether those ruleIds actually exist in the findings.
 * Pure, deterministic — used for explainability + reviewer trust.
 */
const buildFactSourceMap = ({ output, findings }) => {
  const known = new Set((findings || []).map((f) => f.ruleId));
  const topPriorities = (output?.topPriorities || []).map((p) => ({
    title: p?.title ?? null,
    ruleId: p?.ruleId ?? null,
    ruleExists: known.has(p?.ruleId),
  }));
  const recommendations = (output?.clientReadyRecommendations || []).map((r) => {
    const ids = Array.isArray(r?.sourceRuleIds) ? r.sourceRuleIds : [];
    return {
      headline: r?.headline ?? null,
      sourceRuleIds: ids,
      allSourcesExist: ids.length > 0 && ids.every((id) => known.has(id)),
    };
  });
  const referencedRuleIds = [
    ...new Set([
      ...topPriorities.map((p) => p.ruleId).filter(Boolean),
      ...recommendations.flatMap((r) => r.sourceRuleIds),
    ]),
  ];
  return {
    referencedRuleIds,
    unknownRuleIds: referencedRuleIds.filter((id) => !known.has(id)),
    topPriorities,
    recommendations,
  };
};

const verifiedAnalystMoneyValues = (report) => {
  const figureLists = [
    report?.executiveFigures,
    report?.rootCauseFigures,
    ...(report?.findings || []).map((item) => item?.figures),
    ...(report?.campaignDeepDives || []).map((item) => item?.figures),
    ...(report?.ruleFindingDispositions || []).map((item) => item?.figures),
    ...(report?.recommendations || []).map((item) => item?.figures),
  ];
  const moneyMetric = /^(spend|cost|revenue|conversionValue|dailyBudget|budget)$/i;
  const values = new Set();
  for (const figure of figureLists.flatMap((list) => list || [])) {
    if (figure?.verified !== true) continue;
    const compute = figure.compute || {};
    const ratioMoney =
      compute.op === "ratio" &&
      /^(spend|cost)$/i.test(String(compute.numerator || "")) &&
      /^(conversions|results|clicks|impressions)$/i.test(
        String(compute.denominator || "")
      );
    const isMoney =
      compute.op === "excess_spend" ||
      (["raw", "sum"].includes(compute.op) &&
        moneyMetric.test(String(compute.metric || ""))) ||
      ratioMoney;
    const value = Number(figure.value);
    if (isMoney && Number.isFinite(value) && value > 0) {
      values.add(Math.round(value));
    }
  }
  return [...values];
};

/**
 * Runs the AI narrative layer on top of the deterministic findings. PRD
 * requires graceful fallback to the deterministic report if AI fails — we
 * never strand the user.
 */
export const processGenerateAiReport = async ({ auditId }) => {
  const audit = await loadAudit(auditId);
  if (!audit) throw new Error(`Audit ${auditId} not found`);

  if (!["PROCESSING", "COMPLETED"].includes(audit.status) || audit.ruleFindings.length === 0) {
    throw new Error(
      `Audit ${auditId} is not in PROCESSING or COMPLETED state with findings; cannot run AI report.`
    );
  }

  const uploadReadiness = calculateUploadReadiness(audit);

  // Pull recent memory summaries so the AI can reference prior audits.
  // Best-effort: AI still runs if this fails.
  let priorAudits = [];
  try {
    priorAudits = await fetchRecentMemorySummaries({
      organizationId: audit.organizationId,
      excludeAuditId: auditId,
      limit: 3,
    });
  } catch (memoryError) {
    await logEvent(
      auditId,
      "MEMORY_SUMMARY_FETCH_FAILED",
      "Failed to fetch recent memory summaries for AI context.",
      { error: memoryError.message }
    );
  }

  // Cost-cap check before invoking the AI provider. Bypassing this would
  // break the per-org and global ceilings since worker jobs don't go through
  // the HTTP middleware chain.
  const { plan: planAtRunTime, subscription: subAtRunTime } =
    await resolveEffectivePlan(audit.organizationId);
  const hasHeadroom = await aiCapsHaveHeadroom({
    organizationId: audit.organizationId,
    effectivePlan: planAtRunTime,
    subscription: subAtRunTime,
    auditId,
  });
  if (!hasHeadroom) {
    await prisma.audit
      .update({
        where: { id: auditId },
        data: { status: "COMPLETED", completedAt: new Date() },
      })
      .catch(() => {});
    return { aiSkipped: true, reason: "cap_reached" };
  }

  const auditWithReadiness = { ...audit, uploadReadiness };
  const context = buildAiAuditContext(auditWithReadiness, { priorAudits });

  let deepAuditResult = null;
  if (isDeepAuditEnabled()) {
    try {
      deepAuditResult = await runDeepAudit({
        audit: auditWithReadiness,
        priorAudits,
        fallback: async ({ reason }) => ({
          report: null,
          reason: reason || "standard_report_continues",
        }),
      });
      context.deepAudit = {
        mode: deepAuditResult.mode,
        report: deepAuditResult.report,
        reasoningTrace: deepAuditResult.reasoningTrace || [],
        reason: deepAuditResult.reason || null,
        usage: deepAuditResult.usage || {},
      };
      await recordAiUsage({
        organizationId: audit.organizationId,
        auditId,
        provider: "anthropic",
        model: DEEP_AUDIT_MODEL,
        purpose: "default_deep_audit",
        inputTokens: deepAuditResult.usage?.inputTokens || 0,
        outputTokens: deepAuditResult.usage?.outputTokens || 0,
        status: String(deepAuditResult.reason || "").startsWith("error:")
          ? "ERROR"
          : "SUCCESS",
        errorMessage: String(deepAuditResult.reason || "").startsWith("error:")
          ? deepAuditResult.reason.slice(0, 500)
          : null,
      });
    } catch (deepError) {
      context.deepAudit = {
        mode: "fallback",
        report: null,
        reasoningTrace: [],
        reason: `error:${deepError.message}`,
        usage: {},
      };
      await logEvent(
        auditId,
        "DEFAULT_DEEP_AUDIT_FAILED",
        "Deep Audit loop failed; standard AI narrative continues.",
        { error: deepError.message }
      );
    }
  }

  // AI Analyst — full-data analysis with deterministic figure verification
  // (spec: docs/AI_ANALYST_SPEC.md). Best-effort: any failure here degrades to
  // the deterministic pipeline; the analyst can only ADD to a report.
  let verifiedAnalyst = null;
  if (isAnalystEnabled()) {
    try {
      const analystArgs = {
        audit: auditWithReadiness,
        // Per-plan model gating (spec §7): free/starter run the budget model,
        // pro/agency the flagship. ANALYST_MODEL env overrides for every tier.
        model: resolveAnalystModel(planAtRunTime?.slug),
      };
      let analystRun;
      try {
        analystRun = await runAnalyst(analystArgs);
      } catch (firstError) {
        // One retry on transient transport/server errors — the analyst call
        // streams for minutes and a single dropped connection ("terminated",
        // "fetch failed") otherwise silently downgrades the whole report to
        // rules-only. Schema/validation errors are NOT retried: same input,
        // same failure.
        const transient = /terminated|fetch failed|econnreset|etimedout|socket hang up|network|overloaded|\b(5\d\d|429)\b/i.test(
          String(firstError?.message || "")
        );
        if (!transient) throw firstError;
        console.warn(
          `[auditPipeline] analyst transient error ("${firstError.message}") — retrying once`
        );
        await new Promise((resolve) => setTimeout(resolve, 5000));
        analystRun = await runAnalyst(analystArgs);
      }
      const verified = verifyAnalystReport({
        report: analystRun.report,
        audit: auditWithReadiness,
        quarantinedCampaigns: analystRun.quarantinedCampaigns,
      });
      verifiedAnalyst = {
        report: verified.report,
        verification: { stats: verified.stats },
      };

      await recordAiUsage({
        organizationId: audit.organizationId,
        auditId,
        provider: "anthropic",
        model: analystRun.model,
        purpose: "analyst",
        inputTokens: analystRun.usage.inputTokens,
        outputTokens: analystRun.usage.outputTokens,
        status: "SUCCESS",
      });

      // Best-effort persistence — if the AnalystReport table isn't pushed yet
      // the report still renders (from rules) and nothing is lost but the run.
      try {
        if (prisma.analystReport?.upsert) {
          const data = {
            provider: "anthropic",
            model: analystRun.model,
            schemaVersion: analystRun.schemaVersion,
            report: verified.report,
            verification: {
              stats: verified.stats,
              droppedFigures: verified.droppedFigures,
              droppedClaims: verified.droppedClaims,
              serialization: analystRun.serialization,
              quarantinedCampaigns: analystRun.quarantinedCampaigns,
            },
            usage: analystRun.usage,
          };
          await prisma.analystReport.upsert({
            where: { auditId },
            create: { auditId, ...data },
            update: data,
          });
        }
      } catch (persistError) {
        console.error("[auditPipeline] analyst persist failed (non-fatal):", persistError.message);
      }

      await logEvent(auditId, "ANALYST_REPORT_GENERATED", "AI analyst report generated and verified.", {
        model: analystRun.model,
        stats: verified.stats,
        datasetTokens: analystRun.serialization.tokenEstimate,
        truncations: analystRun.serialization.truncations.length,
      });
    } catch (analystError) {
      await recordAiUsage({
        organizationId: audit.organizationId,
        auditId,
        provider: "anthropic",
        model: ANALYST_MODEL,
        purpose: "analyst",
        inputTokens: 0,
        outputTokens: 0,
        status: "ERROR",
        errorMessage: String(analystError.message || analystError).slice(0, 500),
      }).catch(() => {});
      await logEvent(
        auditId,
        "ANALYST_REPORT_FAILED",
        "AI analyst failed; report continues from deterministic findings.",
        { error: analystError.message }
      );
    }
  }

  if (verifiedAnalyst) {
    context.verifiedAnalyst = verifiedAnalyst;
    if (context.evidencePacket) {
      const analystMoney = verifiedAnalystMoneyValues(verifiedAnalyst.report);
      context.evidencePacket.verifiedNumbers = [
        ...new Set([
          ...(context.evidencePacket.verifiedNumbers || []),
          ...analystMoney,
        ]),
      ].sort((a, b) => a - b);
    }
  }

  const result = await tryGenerateValidatedAiReport({
    context,
    findings: audit.ruleFindings,
    auditId,
    organizationId: audit.organizationId,
  });

  if (!result.ok) {
    await logEvent(
      auditId,
      "AI_REPORT_FALLBACK",
      "AI report generation failed after retries. Deterministic report retained.",
      { attempts: result.attempts, maxAttempts: AI_REPORT_MAX_ATTEMPTS }
    );
    await prisma.audit
      .update({
        where: { id: auditId },
        data: { status: "COMPLETED", completedAt: new Date() },
      })
      .catch(() => {});
    return { aiFallbackUsed: true, attempts: result.attempts };
  }

  const generated = result.report;

  // Fact source map — links each AI top priority + recommendation to the
  // ruleIds that support it, and verifies those ruleIds exist. Explainability
  // + reviewer trust. Stored in promptMeta (not customer-facing).
  const factSourceMap = buildFactSourceMap({
    output: generated.output,
    findings: audit.ruleFindings,
  });

  const promptMeta = {
    aiGenerated: true,
    responseId: generated.responseId,
    uploadReadiness,
    contextLimits: context.contextLimits,
    attemptsUsed: result.attempt,
    priorAttempts: result.attempts,
    factSourceMap,
    factualityWarnings: [],
    qualityWarnings: result.qualityWarnings || [],
    defaultDeepAudit: context.deepAudit
      ? {
          mode: context.deepAudit.mode,
          reason: context.deepAudit.reason,
          usage: context.deepAudit.usage,
          toolCalls: (context.deepAudit.reasoningTrace || []).map((step) => ({
            tool: step.tool,
            phase: step.phase,
          })),
        }
      : null,
  };

  await prisma.aiReport.upsert({
    where: { auditId },
    create: {
      auditId,
      provider: generated.provider,
      model: generated.model,
      promptMeta,
      output: generated.output,
    },
    update: {
      provider: generated.provider,
      model: generated.model,
      promptMeta,
      output: generated.output,
    },
  });

  // Deep audit is done — mark the audit COMPLETED so the frontend shows results.
  await prisma.audit.update({
    where: { id: auditId },
    data: { status: "COMPLETED", completedAt: new Date() },
  });

  await logEvent(auditId, "AI_REPORT_GENERATED", "AI report generated and saved.", {
    provider: generated.provider,
    model: generated.model,
    responseId: generated.responseId,
    attemptsUsed: result.attempt,
  });

  // Non-factual quality warnings remain observable but do not block delivery.
  if (result.qualityWarnings?.length > 0) {
    await logEvent(
      auditId,
      "AI_REPORT_QUALITY_WARNING",
      "AI output passed factuality checks but has narrative quality warnings.",
      { warnings: result.qualityWarnings }
    );
  }

  return {
    aiFallbackUsed: false,
    attemptsUsed: result.attempt,
    factualityWarnings: [],
    qualityWarnings: result.qualityWarnings || [],
  };
};

/**
 * Generates a versioned PDF report.
 */
export const processGeneratePdfReport = async ({ auditId }) => {
  const audit = await loadAudit(auditId);
  if (!audit) throw new Error(`Audit ${auditId} not found`);

  if (audit.status !== "COMPLETED") {
    throw new Error(
      `Audit ${auditId} is not in COMPLETED state; cannot generate PDF.`
    );
  }

  const uploadReadiness = calculateUploadReadiness(audit);
  const version = (audit.pdfReports[0]?.version || 0) + 1;
  const branding = audit.organization?.brandingSettings || {};

  // Continuity: the prior audit for this account powers the "Since your last
  // audit" trend section. Best-effort — never block PDF generation on it.
  let previousAudit = null;
  try {
    previousAudit = await fetchPreviousAudit({
      organizationId: audit.organizationId,
      adAccountId: audit.adAccountId,
      platforms: audit.selectedPlatforms,
      beforeCompletedAt: audit.completedAt,
      excludeAuditId: audit.id,
    });
  } catch (trendErr) {
    console.warn(`[auditPipeline] previous-audit lookup failed (non-fatal): ${trendErr.message}`);
  }

  const generatedPdf = await generateAuditPdfFile({
    audit: { ...audit, uploadReadiness, previousAudit },
    version,
    branding,
  });

  const pdfReport = await prisma.pdfReport.create({
    data: {
      auditId,
      storagePath: generatedPdf.storagePath,
      version,
    },
  });

  await logEvent(auditId, "PDF_REPORT_GENERATED", "PDF report generated and saved.", {
    pdfReportId: pdfReport.id,
    version,
  });

  return { pdfReportId: pdfReport.id, version };
};
