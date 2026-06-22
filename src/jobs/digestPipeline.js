import { prisma } from "../lib/prisma.js";
import { fetchPreviousAudit } from "../modules/audits/auditHistory.service.js";
import { computeAuditDelta, buildDigestEmail } from "../modules/alerts/digest.service.js";
import { resolveAccountAlertRecipients } from "../modules/alerts/recipients.js";
import { sendAuditAlertEmail } from "../utils/email.js";

const DIGEST_LOOKBACK_DAYS = Number(process.env.DIGEST_LOOKBACK_DAYS || 8);
const DIGEST_COOLDOWN_MS = Number(process.env.DIGEST_COOLDOWN_MS || 6 * 24 * 60 * 60 * 1000);
const DIGEST_CRON_INTERVAL_MS = Number(process.env.DIGEST_CRON_INTERVAL_MS || 24 * 60 * 60 * 1000);

const logEvent = (auditId, type, message, metadata) =>
  prisma.auditEvent
    .create({ data: { auditId, type, message, metadata } })
    .catch((error) => console.error(`[digestPipeline] event log failed (${type})`, error.message));

/**
 * Weekly-digest scan. For each account whose latest audit is recent and not yet
 * digested, and which hasn't had a digest in the cooldown window (so the cadence
 * stays ~weekly no matter how often they audit), build and email the rollup.
 *
 * Idempotent (an AUDIT_DIGEST_SENT event per audit) and fail-safe (per-account
 * errors are logged, never thrown). Runs from a daily cron; the cooldown — not
 * the cron frequency — sets the real cadence.
 */
export const processWeeklyDigest = async () => {
  const since = new Date(Date.now() - DIGEST_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  const recent = await prisma.audit.findMany({
    where: { status: "COMPLETED", completedAt: { gte: since }, adAccountId: { not: null } },
    orderBy: { completedAt: "desc" },
    select: {
      id: true,
      organizationId: true,
      adAccountId: true,
      createdById: true,
      selectedPlatforms: true,
      completedAt: true,
      healthScore: true,
      adAccount: { select: { name: true, assignedUserId: true } },
      normalizedDataset: { select: { summary: true } },
      ruleFindings: { select: { ruleId: true, title: true, severity: true, estimatedImpact: true, evidence: true } },
    },
  });

  // Latest audit per account only — one digest per account, not per audit.
  const latestByAccount = new Map();
  for (const a of recent) if (!latestByAccount.has(a.adAccountId)) latestByAccount.set(a.adAccountId, a);

  let sent = 0;
  for (const audit of latestByAccount.values()) {
    try {
      // Already digested this exact audit?
      const already = await prisma.auditEvent.findFirst({
        where: { auditId: audit.id, type: "AUDIT_DIGEST_SENT" },
        select: { id: true },
      });
      if (already) continue;

      // Weekly cadence guard — skip if this account got a digest recently.
      const lastDigest = await prisma.auditEvent.findFirst({
        where: { type: "AUDIT_DIGEST_SENT", audit: { adAccountId: audit.adAccountId } },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      });
      if (lastDigest && Date.now() - new Date(lastDigest.createdAt).getTime() < DIGEST_COOLDOWN_MS) {
        continue;
      }

      const previous = await fetchPreviousAudit({
        organizationId: audit.organizationId,
        adAccountId: audit.adAccountId,
        platforms: audit.selectedPlatforms,
        beforeCompletedAt: audit.completedAt,
        excludeAuditId: audit.id,
      });
      if (!previous) {
        // First audit for this account — nothing to compare yet.
        await logEvent(audit.id, "AUDIT_DIGEST_SKIPPED", "No prior audit to compare; digest skipped.");
        continue;
      }

      const totals = audit.normalizedDataset?.summary?.totals || {};
      const currency = totals.currency || "USD";
      const delta = computeAuditDelta({
        current: { healthScore: audit.healthScore, completedAt: audit.completedAt, totals, findings: audit.ruleFindings || [] },
        previous,
        currency,
      });
      if (!delta || delta.metrics.length === 0) {
        await logEvent(audit.id, "AUDIT_DIGEST_SKIPPED", "No comparable metrics; digest skipped.");
        continue;
      }

      const recipients = await resolveAccountAlertRecipients(audit);
      if (recipients.length === 0) {
        await logEvent(audit.id, "AUDIT_DIGEST_SKIPPED", "No recipients (all muted / none routed).");
        continue;
      }

      const reportUrl = process.env.CLIENT_ORIGIN
        ? `${process.env.CLIENT_ORIGIN}/dashboard/audits/${audit.id}/results`
        : null;
      const email = buildDigestEmail({ accountName: audit.adAccount?.name, delta, reportUrl });

      await sendAuditAlertEmail({ to: recipients.join(", "), ...email });
      await logEvent(audit.id, "AUDIT_DIGEST_SENT", "Weekly digest sent.", { recipients: recipients.length });
      sent += 1;
    } catch (error) {
      console.error(`[digestPipeline] digest failed for audit ${audit.id}:`, error.message);
    }
  }

  return { sent, scanned: latestByAccount.size };
};

let cronHandle = null;

/**
 * Start the daily digest scan. The per-account cooldown keeps the real cadence
 * weekly. Fail-safe; unref'd so it never holds the process open.
 */
export const startWeeklyDigestCron = () => {
  if (cronHandle) return cronHandle;
  cronHandle = setInterval(async () => {
    try {
      const { sent } = await processWeeklyDigest();
      if (sent > 0) console.log(`[digestCron] Sent ${sent} weekly digest(s).`);
    } catch (err) {
      console.error("[digestCron] digest scan failed", err);
    }
  }, DIGEST_CRON_INTERVAL_MS);
  if (typeof cronHandle.unref === "function") cronHandle.unref();
  return cronHandle;
};
