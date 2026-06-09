import { enqueue, registerProcessor } from "./jobQueue.js";
import {
  processGenerateAiReport,
  processGeneratePdfReport,
  processRunAudit,
} from "../jobs/auditPipeline.js";
import { prisma } from "../lib/prisma.js";

export const AUDIT_RUN_QUEUE = "audit-run";
export const AUDIT_AI_REPORT_QUEUE = "audit-ai-report";
export const AUDIT_PDF_QUEUE = "audit-pdf";

const safeMarkFailed = async (auditId, error) => {
  try {
    await prisma.audit.update({
      where: { id: auditId },
      data: { status: "FAILED" },
    });
    await prisma.auditEvent.create({
      data: {
        auditId,
        type: "AUDIT_RUN_FAILED",
        message: "Audit job failed during processing.",
        metadata: { error: error?.message || "Unknown error" },
      },
    });
  } catch {
    // best-effort — don't mask the underlying failure
  }
};

/**
 * Wire up processors. Call this once per process — from app.js for inline
 * mode, and from worker.js for Bull mode. Idempotent because the underlying
 * registry uses a Map keyed by name.
 */
export const initializeAuditQueueProcessors = () => {
  registerProcessor(AUDIT_RUN_QUEUE, async (data) => {
    try {
      return await processRunAudit(data);
    } catch (error) {
      await safeMarkFailed(data.auditId, error);
      throw error;
    }
  });

  registerProcessor(AUDIT_AI_REPORT_QUEUE, async (data) => {
    try {
      return await processGenerateAiReport(data);
    } catch (error) {
      // AI failure does NOT mark the audit FAILED — the deterministic report
      // is the floor. Ensure the audit is COMPLETED so the user is never
      // stranded in PROCESSING indefinitely.
      await prisma.audit
        .update({
          where: { id: data.auditId },
          data: { status: "COMPLETED", completedAt: new Date() },
        })
        .catch(() => {});
      await prisma.auditEvent
        .create({
          data: {
            auditId: data.auditId,
            type: "AI_REPORT_FALLBACK",
            message: "AI report job threw unexpectedly. Deterministic report retained.",
            metadata: { error: error?.message },
          },
        })
        .catch(() => {});
      // Don't rethrow — we don't want Bull to retry forever on broken AI keys.
      return { aiFallbackUsed: true, error: error?.message };
    }
  });

  registerProcessor(AUDIT_PDF_QUEUE, async (data) => {
    try {
      return await processGeneratePdfReport(data);
    } catch (error) {
      await prisma.auditEvent
        .create({
          data: {
            auditId: data.auditId,
            type: "PDF_REPORT_FAILED",
            message: "PDF generation job failed.",
            metadata: { error: error?.message },
          },
        })
        .catch(() => {});
      throw error;
    }
  });
};

export const enqueueRunAudit = (data) => enqueue(AUDIT_RUN_QUEUE, data);
export const enqueueGenerateAiReport = (data) =>
  enqueue(AUDIT_AI_REPORT_QUEUE, data);
export const enqueueGeneratePdfReport = (data) =>
  enqueue(AUDIT_PDF_QUEUE, data);
