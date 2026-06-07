/**
 * Deep Audit — service glue. (spec: docs/DEEP_AUDIT_SPEC.md)
 *
 * Loads an audit bundle, runs the agentic orchestrator with the REAL fallback
 * (the standard single-shot AI report) and records cost, then best-effort
 * persists the deep result. Runs synchronously for now (explicit premium action,
 * flag-gated, self-bounded loop); the same function can later be called from a
 * BullMQ worker to move it off the request path.
 *
 * Dependencies are injectable so the glue is unit-testable without a DB or LLM.
 */

import { prisma as realPrisma } from "../../../lib/prisma.js";
import { badRequest, notFound } from "../../../utils/appError.js";
import { calculateUploadReadiness } from "../uploadReadiness.service.js";
import { fetchRecentMemorySummaries } from "../memorySummary.service.js";
import { buildAiAuditContext } from "../aiContext.service.js";
import { generateAiAuditReport } from "../aiProvider.service.js";
import { recordAiUsage } from "../aiUsage.service.js";
import { runDeepAudit } from "./orchestrator.js";
import { DEEP_AUDIT_MODEL } from "./config.js";

const AUDIT_INCLUDE = {
  adAccount: { select: { name: true } },
  normalizedDataset: true,
  ruleFindings: true,
  intakeResponses: true,
  aiReport: true,
};

/**
 * Run a Deep Audit for one audit and return the result. Throws notFound /
 * badRequest for the obvious gates; never throws for LLM/DB issues (those
 * degrade to the standard report inside the orchestrator / are best-effort).
 *
 * @param {{auditId:string, organizationId:string}} args
 * @param {object} [deps] injectable dependencies (tests)
 */
export const runDeepAuditForAudit = async (
  { auditId, organizationId },
  deps = {}
) => {
  const {
    prisma = realPrisma,
    fetchPriors = fetchRecentMemorySummaries,
    buildContext = buildAiAuditContext,
    generateStandard = generateAiAuditReport,
    runLoop = runDeepAudit,
    record = recordAiUsage,
    readiness = calculateUploadReadiness,
    model = DEEP_AUDIT_MODEL,
  } = deps;

  const audit = await prisma.audit.findFirst({
    where: { id: auditId, organizationId },
    include: AUDIT_INCLUDE,
  });

  if (!audit) throw notFound("Audit not found");
  if (audit.status !== "COMPLETED" || (audit.ruleFindings || []).length === 0) {
    throw badRequest("Run the deterministic audit before a Deep Audit.");
  }

  const auditWithReadiness = {
    ...audit,
    uploadReadiness: readiness(audit),
  };

  // Prior audits power peer + self-over-time comparison. Best-effort.
  let priorAudits = [];
  try {
    priorAudits = await fetchPriors({
      organizationId,
      excludeAuditId: auditId,
      limit: 3,
    });
  } catch {
    priorAudits = [];
  }

  // Real deterministic fallback = the standard single-shot AI report. The
  // Deep Audit can never produce a worse outcome than the standard path.
  const fallback = async () => {
    const context = buildContext(auditWithReadiness, { priorAudits });
    const standard = await generateStandard({
      context,
      auditId,
      organizationId,
      purpose: "deep_audit_fallback",
    });
    return { report: standard.output, reason: "fallback_standard" };
  };

  const result = await runLoop({
    audit: auditWithReadiness,
    priorAudits,
    fallback,
  });

  // Record the deep loop's own token spend (the fallback records its own).
  await record({
    organizationId,
    auditId,
    provider: "anthropic",
    model,
    purpose: "deep_audit",
    inputTokens: result.usage?.inputTokens || 0,
    outputTokens: result.usage?.outputTokens || 0,
    status: String(result.reason || "").startsWith("error:") ? "ERROR" : "SUCCESS",
    errorMessage: String(result.reason || "").startsWith("error:")
      ? result.reason.slice(0, 500)
      : null,
  });

  // Best-effort persistence. If the DeepAuditReport table isn't migrated yet
  // (feature is flag-gated off by default), the result is still returned.
  try {
    if (prisma.deepAuditReport?.upsert) {
      const data = {
        provider: "anthropic",
        model,
        mode: result.mode,
        report: result.report ?? {},
        reasoningTrace: result.reasoningTrace ?? [],
        usage: result.usage ?? {},
      };
      await prisma.deepAuditReport.upsert({
        where: { auditId },
        create: { auditId, ...data },
        update: data,
      });
    }
  } catch (err) {
    console.error("[deepAudit] persist failed (non-fatal):", err?.message);
  }

  return {
    auditId,
    mode: result.mode,
    report: result.report,
    reasoningTrace: result.reasoningTrace,
    reason: result.reason,
    usage: result.usage,
  };
};
