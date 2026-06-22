import { prisma } from "../lib/prisma.js";
import { syncGoogleToAudit } from "../modules/platformConnections/platformConnections.controller.js";
import { enqueueRunAudit } from "../queues/auditQueue.js";
import { selectDueAccounts } from "../modules/audits/reaudit.service.js";

/**
 * Scheduled re-audit — the "audits run themselves weekly" piece that closes the
 * monitoring loop. For each MONITORED account that is due, it clones the prior
 * audit's settings, re-pulls fresh OAuth data headlessly, and runs the full
 * pipeline (engine → AI → which fires the alert + digest flows).
 *
 * SAFETY: off by default. Requires BOTH the org/user to opt an account in
 * (AdAccount.monitoringEnabled) AND the AUTO_REAUDIT_ENABLED flag — because an
 * auto-run consumes the org's plan quota + AI cost. v1 covers GOOGLE only (its
 * sync is extracted headlessly); Meta/TikTok monitored accounts are skipped
 * until their syncs are made headless.
 */

const ENABLED = String(process.env.AUTO_REAUDIT_ENABLED || "").toLowerCase() === "true";
const INTERVAL_MS = Number(process.env.AUTO_REAUDIT_INTERVAL_MS || 7 * 24 * 60 * 60 * 1000);
const CRON_INTERVAL_MS = Number(process.env.AUTO_REAUDIT_CRON_INTERVAL_MS || 6 * 60 * 60 * 1000);

const logEvent = (auditId, type, message, metadata) =>
  prisma.auditEvent
    .create({ data: { auditId, type, message, metadata } })
    .catch((error) => console.error(`[reauditPipeline] event log failed (${type})`, error.message));

export const processScheduledReaudits = async () => {
  if (!ENABLED) return { skipped: "disabled" };

  const accounts = await prisma.adAccount.findMany({
    where: { monitoringEnabled: true, platform: "GOOGLE" },
    select: {
      id: true,
      organizationId: true,
      name: true,
      externalId: true,
      monitoringEnabled: true,
      lastAutoAuditAt: true,
      connections: {
        where: { platform: "GOOGLE", status: "ACTIVE" },
        select: { externalAccountId: true },
      },
    },
  });

  const due = selectDueAccounts({ accounts, now: Date.now(), intervalMs: INTERVAL_MS });

  let started = 0;
  for (const account of due) {
    try {
      const customerId = account.connections?.[0]?.externalAccountId || account.externalId;
      if (!customerId) continue; // no connected customer id — can't sync

      // Clone the most recent completed audit's settings (profile + intake) so
      // the re-audit uses the same context the user configured.
      const prior = await prisma.audit.findFirst({
        where: { adAccountId: account.id, organizationId: account.organizationId, status: "COMPLETED" },
        orderBy: { completedAt: "desc" },
        include: { intakeResponses: true },
      });
      if (!prior) continue; // need a baseline to clone from

      const newAudit = await prisma.audit.create({
        data: {
          organizationId: account.organizationId,
          adAccountId: account.id,
          createdById: prior.createdById,
          status: "PROCESSING",
          dataSource: "OAUTH",
          selectedPlatforms: prior.selectedPlatforms,
          businessProfileSnapshot: prior.businessProfileSnapshot ?? undefined,
          startedAt: new Date(),
          intakeResponses: {
            create: (prior.intakeResponses || []).map((r) => ({ section: r.section, answers: r.answers })),
          },
        },
        select: { id: true },
      });

      await logEvent(newAudit.id, "AUTO_REAUDIT_STARTED", `Scheduled re-audit started for ${account.name}.`, {
        accountId: account.id,
      });

      // Fresh data pull (headless), then run the existing pipeline.
      await syncGoogleToAudit({ organizationId: account.organizationId, auditId: newAudit.id, customerId });
      await enqueueRunAudit({ auditId: newAudit.id, organizationId: account.organizationId });

      await prisma.adAccount.update({
        where: { id: account.id },
        data: { lastAutoAuditAt: new Date() },
      });
      started += 1;
    } catch (error) {
      console.error(`[reauditPipeline] re-audit failed for account ${account.id}:`, error.message);
    }
  }

  return { started, due: due.length };
};

let cronHandle = null;

/**
 * Start the re-audit scan. No-op unless AUTO_REAUDIT_ENABLED — so the feature is
 * inert until explicitly turned on. Fail-safe + unref'd.
 */
export const startReauditCron = () => {
  if (!ENABLED || cronHandle) return cronHandle;
  cronHandle = setInterval(async () => {
    try {
      const { started } = await processScheduledReaudits();
      if (started) console.log(`[reauditCron] Started ${started} scheduled re-audit(s).`);
    } catch (err) {
      console.error("[reauditCron] scan failed", err);
    }
  }, CRON_INTERVAL_MS);
  if (typeof cronHandle.unref === "function") cronHandle.unref();
  return cronHandle;
};
