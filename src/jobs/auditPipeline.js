import { prisma } from "../lib/prisma.js";
import { runDeterministicAudit } from "../modules/audits/auditEngine.service.js";
import { calculateUploadReadiness } from "../modules/audits/uploadReadiness.service.js";
import { buildAiAuditContext } from "../modules/audits/aiContext.service.js";
import { generateAiAuditReport } from "../modules/audits/aiProvider.service.js";
import { validateAiReportOutput } from "../modules/audits/aiReportValidation.service.js";
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

  await prisma.$transaction(async (tx) => {
    await tx.ruleFinding.deleteMany({ where: { auditId } });

    if (engineResult.findings.length > 0) {
      await tx.ruleFinding.createMany({
        data: engineResult.findings.map((finding) => ({
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

const tryGenerateValidatedAiReport = async ({ context, findings }) => {
  const attempts = [];

  for (let attempt = 1; attempt <= AI_REPORT_MAX_ATTEMPTS; attempt += 1) {
    try {
      const generated = await generateAiAuditReport({ context });
      const validation = validateAiReportOutput({
        output: generated.output,
        findings,
      });

      if (validation.isValid) {
        return { ok: true, attempt, report: generated, attempts };
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

  const context = buildAiAuditContext(
    { ...audit, uploadReadiness },
    { priorAudits }
  );

  const result = await tryGenerateValidatedAiReport({
    context,
    findings: audit.ruleFindings,
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

  await prisma.aiReport.upsert({
    where: { auditId },
    create: {
      auditId,
      provider: generated.provider,
      model: generated.model,
      promptMeta: {
        aiGenerated: true,
        responseId: generated.responseId,
        uploadReadiness,
        contextLimits: context.contextLimits,
        attemptsUsed: result.attempt,
        priorAttempts: result.attempts,
      },
      output: generated.output,
    },
    update: {
      provider: generated.provider,
      model: generated.model,
      promptMeta: {
        aiGenerated: true,
        responseId: generated.responseId,
        uploadReadiness,
        contextLimits: context.contextLimits,
        attemptsUsed: result.attempt,
        priorAttempts: result.attempts,
      },
      output: generated.output,
    },
  });

  await logEvent(auditId, "AI_REPORT_GENERATED", "AI report generated and saved.", {
    provider: generated.provider,
    model: generated.model,
    responseId: generated.responseId,
    attemptsUsed: result.attempt,
  });

  return { aiFallbackUsed: false, attemptsUsed: result.attempt };
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
