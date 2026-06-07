import { prisma } from "../lib/prisma.js";
import { runDeterministicAudit } from "../modules/audits/auditEngine.service.js";
import { calculateUploadReadiness } from "../modules/audits/uploadReadiness.service.js";
import { buildAiAuditContext } from "../modules/audits/aiContext.service.js";
import { generateAiAuditReport } from "../modules/audits/aiProvider.service.js";
import {
  validateAiReportOutput,
  validateAiReportFactuality,
  validateRecommendationsNotGeneric,
} from "../modules/audits/aiReportValidation.service.js";
import { generateAuditPdfFile } from "../modules/audits/pdfReport.service.js";
import {
  getAiNarrativeMode,
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
  // Per-org monthly cap.
  const orgCap =
    effectivePlan?.aiMonthlyUsdCap != null
      ? Number(effectivePlan.aiMonthlyUsdCap)
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
  pdfReports: { orderBy: { version: "desc" } },
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
        status: "COMPLETED",
        healthScore: engineResult.scores.overall,
        categoryScores: engineResult.scores,
        completedAt: new Date(),
      },
    });
  });

  await logEvent(auditId, "AUDIT_ENGINE_COMPLETED", "Deterministic audit engine completed.", {
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
  // the score-trend chart on the dashboard. A failure here doesn't fail the
  // audit; the audit is already COMPLETED.
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

  // Plan-gated auto-AI: Pro/Agency plans chain the AI narrative job
  // automatically so users get a polished report without an extra click.
  // Starter is "manual" (button stays), Free is `false` (no AI access).
  // Dynamic import avoids a circular dep with auditQueue → auditPipeline.
  let aiAutoQueued = false;
  try {
    const { plan } = await resolveEffectivePlan(organizationId);
    const aiMode = getAiNarrativeMode(plan);
    if (aiMode === "automatic") {
      const { enqueueGenerateAiReport } = await import(
        "../queues/auditQueue.js"
      );
      await enqueueGenerateAiReport({ auditId });
      aiAutoQueued = true;
      await logEvent(
        auditId,
        "AI_REPORT_AUTO_QUEUED",
        "AI report auto-queued by plan policy.",
        { plan: plan?.slug || null }
      );
    }
  } catch (autoAiError) {
    // Auto-chain failures must NOT fail the audit. The user can always
    // click "Generate AI report" manually.
    await logEvent(
      auditId,
      "AI_REPORT_AUTO_QUEUE_FAILED",
      "Failed to auto-queue AI report after deterministic run.",
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
        // Lightweight factuality pass — never hard-fails (keeps retries/
        // fallback intact), but surfaces invented dollar figures for
        // monitoring + future prompt tuning.
        const factuality = validateAiReportFactuality({
          output: generated.output,
          verifiedNumbers: context?.evidencePacket?.verifiedNumbers || [],
        });
        const genericCheck = validateRecommendationsNotGeneric({
          output: generated.output,
        });
        return {
          ok: true,
          attempt,
          report: generated,
          attempts,
          factualityWarnings: [
            ...factuality.warnings,
            ...genericCheck.warnings,
          ],
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
      attempts.push({
        attempt,
        type: "PROVIDER_ERROR",
        message: error?.message,
        details: error?.details,
      });
    }
  }

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

/**
 * Runs the AI narrative layer on top of the deterministic findings. PRD
 * requires graceful fallback to the deterministic report if AI fails — we
 * never strand the user.
 */
export const processGenerateAiReport = async ({ auditId }) => {
  const audit = await loadAudit(auditId);
  if (!audit) throw new Error(`Audit ${auditId} not found`);

  if (audit.status !== "COMPLETED" || audit.ruleFindings.length === 0) {
    throw new Error(
      `Audit ${auditId} is not in COMPLETED state with findings; cannot run AI report.`
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
    // Don't fail the audit — the deterministic report is already saved.
    return { aiSkipped: true, reason: "cap_reached" };
  }

  const context = buildAiAuditContext(
    { ...audit, uploadReadiness },
    { priorAudits }
  );

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
    factualityWarnings: result.factualityWarnings || [],
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

  await logEvent(auditId, "AI_REPORT_GENERATED", "AI report generated and saved.", {
    provider: generated.provider,
    model: generated.model,
    responseId: generated.responseId,
    attemptsUsed: result.attempt,
  });

  // Surface any invented dollar figures for monitoring (non-blocking).
  if (result.factualityWarnings?.length > 0) {
    await logEvent(
      auditId,
      "AI_REPORT_FACTUALITY_WARNING",
      "AI output referenced dollar figures not present in verified evidence.",
      { warnings: result.factualityWarnings }
    );
  }

  return {
    aiFallbackUsed: false,
    attemptsUsed: result.attempt,
    factualityWarnings: result.factualityWarnings || [],
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

  const generatedPdf = await generateAuditPdfFile({
    audit: { ...audit, uploadReadiness },
    version,
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
