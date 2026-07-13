/**
 * AI Analyst — live validation run. (spec: docs/AI_ANALYST_SPEC.md §8.2)
 *
 * For the latest COMPLETED audit on each platform: runs the full analyst
 * pipeline (serialize → Opus → verify), persists the AnalystReport, re-renders
 * the premium report HTML to storage/pdf-reports/, and prints the verification
 * stats. Run with: node --env-file=.env scripts/analystLiveRun.mjs [auditId ...]
 */

import fs from "node:fs";
import path from "node:path";
import { prisma } from "../src/lib/prisma.js";
import { runAnalyst } from "../src/modules/audits/analyst/analystRun.service.js";
import { verifyAnalystReport } from "../src/modules/audits/analyst/analystVerification.service.js";
import { calculateUploadReadiness } from "../src/modules/audits/uploadReadiness.service.js";
import { renderAuditPremiumReportHtml } from "../src/modules/audits/premiumReportRenderer.service.js";

const include = {
  adAccount: true,
  intakeResponses: true,
  normalizedDataset: true,
  ruleFindings: { orderBy: { createdAt: "desc" } },
  aiReport: true,
  organization: { select: { brandingSettings: true, name: true } },
};

const pickAudits = async () => {
  const explicit = process.argv.slice(2);
  if (explicit.length > 0) {
    return prisma.audit.findMany({ where: { id: { in: explicit } }, include });
  }
  const picked = [];
  for (const platform of ["GOOGLE", "META"]) {
    const audit = await prisma.audit.findFirst({
      where: { status: "COMPLETED", selectedPlatforms: { has: platform } },
      orderBy: { completedAt: "desc" },
      include,
    });
    if (audit) picked.push(audit);
  }
  return picked;
};

const main = async () => {
  const audits = await pickAudits();
  if (audits.length === 0) {
    console.log("No completed audits found.");
    return;
  }

  for (const audit of audits) {
    const label = `${audit.selectedPlatforms.join("+")} ${audit.adAccount?.name || audit.id}`;
    console.log(`\n━━━ ${label} (${audit.id}) ━━━`);
    const bundle = { ...audit, uploadReadiness: calculateUploadReadiness(audit) };

    const started = Date.now();
    let run;
    try {
      run = await runAnalyst({ audit: bundle });
    } catch (err) {
      console.error(`  ANALYST FAILED: ${err.message}`);
      continue;
    }
    const seconds = Math.round((Date.now() - started) / 1000);

    const verified = verifyAnalystReport({
      report: run.report,
      audit: bundle,
      quarantinedCampaigns: run.quarantinedCampaigns,
    });

    console.log(`  model=${run.model} in ${seconds}s`);
    console.log(
      `  tokens: dataset≈${run.serialization.tokenEstimate} in=${run.usage.inputTokens} out=${run.usage.outputTokens}`
    );
    console.log(`  truncations: ${JSON.stringify(run.serialization.truncations)}`);
    console.log(`  quarantined: ${JSON.stringify(run.quarantinedCampaigns)}`);
    console.log(`  verification: ${JSON.stringify(verified.stats)}`);
    if (verified.droppedFigures.length > 0) {
      console.log(`  DROPPED FIGURES:`);
      for (const d of verified.droppedFigures) {
        console.log(`    - ${d.path} "${d.label}" claimed=${d.claimed} recomputed=${d.recomputed} (${d.reason})`);
      }
    }
    console.log(`  findings: ${verified.report.findings.length}, deepDives: ${verified.report.campaignDeepDives.length}, recs: ${verified.report.recommendations.length}`);
    const dispositionCounts = verified.report.ruleFindingDispositions.reduce((acc, d) => {
      acc[d.disposition] = (acc[d.disposition] || 0) + 1;
      return acc;
    }, {});
    console.log(`  dispositions: ${JSON.stringify(dispositionCounts)}`);

    const data = {
      provider: "anthropic",
      model: run.model,
      schemaVersion: run.schemaVersion,
      report: verified.report,
      verification: {
        stats: verified.stats,
        droppedFigures: verified.droppedFigures,
        serialization: run.serialization,
        quarantinedCampaigns: run.quarantinedCampaigns,
      },
      usage: run.usage,
    };
    await prisma.analystReport.upsert({
      where: { auditId: audit.id },
      create: { auditId: audit.id, ...data },
      update: data,
    });
    console.log(`  persisted AnalystReport`);

    // Re-render the premium report with the analyst merged in.
    const fresh = await prisma.audit.findUnique({
      where: { id: audit.id },
      include: { ...include, analystReport: true },
    });
    const html = renderAuditPremiumReportHtml(
      { ...fresh, uploadReadiness: calculateUploadReadiness(fresh) },
      fresh.organization?.brandingSettings || {}
    );
    const outPath = path.resolve(
      process.cwd(),
      "storage/pdf-reports",
      `analyst-validation-${audit.id}.html`
    );
    await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
    await fs.promises.writeFile(outPath, html, "utf8");
    console.log(`  rendered: ${outPath}`);
    console.log(`  exec summary: ${verified.report.executiveSummary.slice(0, 220)}…`);
  }

  await prisma.$disconnect();
};

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
