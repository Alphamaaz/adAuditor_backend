/**
 * Stuck-audit reconciliation.
 *
 * Any audit left in PROCESSING for > STUCK_THRESHOLD_MS is considered
 * abandoned (likely caused by an inline-mode crash or a worker that died
 * mid-job). We mark it FAILED with a clear reason so polling clients
 * see a definitive state.
 *
 * Run modes:
 *   - reconcileStuckAuditsOnce() — called at boot from server.js
 *   - startStuckAuditCron()      — periodic interval (default every 5 min)
 *
 * Fail-safe: any error is logged but never thrown to the caller.
 */

import { prisma } from "../lib/prisma.js";

const STUCK_THRESHOLD_MS = Number(
  process.env.STUCK_AUDIT_THRESHOLD_MS || 15 * 60 * 1000
);
const RECONCILE_INTERVAL_MS = Number(
  process.env.STUCK_AUDIT_RECONCILE_INTERVAL_MS || 5 * 60 * 1000
);

const STUCK_REASON =
  "Audit timed out — the processing job did not complete within the allowed window. " +
  "This is typically caused by a server restart or worker failure during processing. " +
  "Please retry the audit.";

export const reconcileStuckAuditsOnce = async () => {
  const cutoff = new Date(Date.now() - STUCK_THRESHOLD_MS);

  const stuck = await prisma.audit.findMany({
    where: {
      status: "PROCESSING",
      OR: [
        { startedAt: { lt: cutoff } },
        { startedAt: null, updatedAt: { lt: cutoff } },
      ],
    },
    select: { id: true },
  });

  if (stuck.length === 0) return { reconciled: 0 };

  // Mark stuck audits FAILED in a single update + write per-audit events.
  await prisma.$transaction([
    prisma.audit.updateMany({
      where: { id: { in: stuck.map((a) => a.id) } },
      data: { status: "FAILED" },
    }),
    prisma.auditEvent.createMany({
      data: stuck.map((a) => ({
        auditId: a.id,
        type: "AUDIT_TIMED_OUT",
        message: STUCK_REASON,
        metadata: { thresholdMs: STUCK_THRESHOLD_MS },
      })),
    }),
  ]);

  return { reconciled: stuck.length };
};

let cronHandle = null;

export const startStuckAuditCron = () => {
  if (cronHandle) return cronHandle;
  cronHandle = setInterval(async () => {
    try {
      const { reconciled } = await reconcileStuckAuditsOnce();
      if (reconciled > 0) {
        // eslint-disable-next-line no-console
        console.warn(
          `[stuckAuditCron] Marked ${reconciled} stuck audit(s) as FAILED.`
        );
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[stuckAuditCron] reconciliation failed", err);
    }
  }, RECONCILE_INTERVAL_MS);
  if (typeof cronHandle.unref === "function") cronHandle.unref();
  return cronHandle;
};

export const stopStuckAuditCron = () => {
  if (!cronHandle) return;
  clearInterval(cronHandle);
  cronHandle = null;
};
