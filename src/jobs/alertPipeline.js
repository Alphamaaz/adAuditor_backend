import { prisma } from "../lib/prisma.js";
import { fetchPreviousAudit } from "../modules/audits/auditHistory.service.js";
import { classifyAlerts, detectCpaRegression } from "../modules/alerts/alertClassifier.js";
import { resolveAccountAlertRecipients } from "../modules/alerts/recipients.js";
import { buildAuditAlertEmail } from "../modules/alerts/alertEmail.service.js";
import { sendAuditAlertEmail } from "../utils/email.js";
import { parseImpactDollars } from "../lib/findings/priority.js";

const logEvent = (auditId, type, message, metadata) =>
  prisma.auditEvent
    .create({ data: { auditId, type, message, metadata } })
    .catch((error) => console.error(`[alertPipeline] event log failed (${type})`, error.message));

const formatMoney = (value, currency = "USD") =>
  `${String(currency || "USD").toUpperCase()} ${Math.round(Number(value) || 0).toLocaleString("en-US")}`;

const impactLabel = (finding, currency) => {
  const amount = parseImpactDollars(finding.estimatedImpact);
  if (finding.evidence?.blocksDelivery === true) {
    return amount > 0 ? `${formatMoney(amount, currency)} of delivery blocked` : "Delivery blocked";
  }
  if (amount > 0) return `${formatMoney(amount, currency)} recoverable`;
  return "Needs attention";
};

/**
 * Smart immediate-alert pipeline. Runs after an audit reaches COMPLETED. Sends a
 * single email only when something URGENT is NEW since the previous audit
 * (delivery block, tracking break, sudden zero-conversion spend, a large new
 * critical leak, or a sharp CPA regression). Idempotent — never double-sends for
 * the same audit. Best-effort: failures are logged, never thrown.
 */
export const processAuditAlert = async ({ auditId }) => {
  const audit = await prisma.audit.findUnique({
    where: { id: auditId },
    include: {
      adAccount: { select: { name: true, assignedUserId: true } },
      ruleFindings: true,
      normalizedDataset: { select: { summary: true } },
    },
  });
  if (!audit || audit.status !== "COMPLETED") return { skipped: "not_completed" };

  // Idempotency guard — retries / re-runs must not re-email.
  const already = await prisma.auditEvent.findFirst({
    where: { auditId, type: "AUDIT_ALERT_SENT" },
    select: { id: true },
  });
  if (already) return { skipped: "already_sent" };

  const previous = await fetchPreviousAudit({
    organizationId: audit.organizationId,
    adAccountId: audit.adAccountId,
    platforms: audit.selectedPlatforms,
    beforeCompletedAt: audit.completedAt,
    excludeAuditId: audit.id,
  });

  const totals = audit.normalizedDataset?.summary?.totals || {};
  const currency = totals.currency || "USD";

  const { immediate } = classifyAlerts({
    findings: audit.ruleFindings || [],
    previousRuleIds: (previous?.findings || []).map((f) => f.ruleId),
    hasPrevious: !!previous,
  });

  const items = immediate.map((f) => ({
    title: f.title,
    impact: impactLabel(f, currency),
    fix: (Array.isArray(f.fixSteps) && f.fixSteps[0]) || "Open the platform and review this campaign.",
  }));

  // Metric regression (CPA spike) — a signal, not a finding. Lead with it.
  if (previous) {
    const reg = detectCpaRegression({ totals, prevTotals: previous.totals || {} });
    if (reg) {
      items.unshift({
        title: `Cost per acquisition rose ${reg.pct}% since your last audit`,
        impact: `${formatMoney(reg.cpaPrev, currency)} → ${formatMoney(reg.cpaNow, currency)}`,
        fix: "Review recent budget, bid, or targeting changes; check the per-campaign breakdown in the report.",
      });
    }
  }

  if (items.length === 0) {
    await logEvent(auditId, "AUDIT_ALERT_SKIPPED", "No new urgent issues since last audit — no alert sent.");
    return { sent: false, reason: "no_urgent_changes" };
  }

  const recipients = await resolveAccountAlertRecipients(audit);
  if (recipients.length === 0) {
    await logEvent(auditId, "AUDIT_ALERT_SKIPPED", "Urgent issues found but no recipient email could be resolved.");
    return { sent: false, reason: "no_recipients" };
  }

  const reportUrl = process.env.CLIENT_ORIGIN
    ? `${process.env.CLIENT_ORIGIN}/dashboard/audits/${auditId}/results`
    : null;

  const email = buildAuditAlertEmail({ accountName: audit.adAccount?.name, items, reportUrl });

  try {
    await sendAuditAlertEmail({ to: recipients.join(", "), ...email });
  } catch (error) {
    await logEvent(auditId, "AUDIT_ALERT_FAILED", "Alert email send failed.", { error: error?.message });
    return { sent: false, reason: "send_failed", error: error?.message };
  }

  await logEvent(auditId, "AUDIT_ALERT_SENT", `Alert sent: ${items.length} urgent item(s).`, {
    count: items.length,
    recipients: recipients.length,
  });
  return { sent: true, count: items.length };
};
