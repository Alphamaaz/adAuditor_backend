/**
 * AI Analyst — OFFLINE dry run (no API credits needed).
 *
 * Exercises the complete analyst pipeline against REAL database audits with a
 * stubbed model: serialize the real dataset (proves the serializer + token
 * budget on real data), inject a synthetic analyst report built from the
 * account's ACTUAL rows — plus one deliberately fabricated figure and one
 * recoverable "estimate" — then verify, persist, merge, and render the premium
 * report HTML. Everything is validated except Claude itself.
 *
 * Run: node --env-file=.env scripts/analystDryRun.mjs [auditId ...]
 */

import fs from "node:fs";
import path from "node:path";
import { prisma } from "../src/lib/prisma.js";
import { runAnalyst } from "../src/modules/audits/analyst/analystRun.service.js";
import { verifyAnalystReport } from "../src/modules/audits/analyst/analystVerification.service.js";
import { serializeDatasetForAnalyst } from "../src/modules/audits/analyst/datasetSerializer.js";
import { rowsWithAnalystRefs } from "../src/modules/audits/analyst/analystRowRef.js";
import { calculateUploadReadiness } from "../src/modules/audits/uploadReadiness.service.js";
import { renderAuditPremiumReportHtml } from "../src/modules/audits/premiumReportRenderer.service.js";

// The dry run exercises serialize → verify → merge → render. The prose-repair
// turn has its own unit tests and would add a second stubbed call here.
process.env.ANALYST_PROSE_REPAIR = "false";

const include = {
  adAccount: true,
  intakeResponses: true,
  normalizedDataset: true,
  ruleFindings: { orderBy: { createdAt: "desc" } },
  aiReport: true,
  organization: { select: { brandingSettings: true, name: true } },
};

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

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

/**
 * Build a schema-valid analyst report grounded in the audit's REAL rows, with
 * two poison pills the verification layer must catch:
 *   - a fabricated spend figure (3× the real value) → must be dropped
 *   - a "recoverable" estimate figure → must be demoted to observation
 */
const syntheticAnalystReport = (audit, platform) => {
  const pd = audit.normalizedDataset?.data?.platforms?.[platform] || {};
  // Reference rows by the same stable rowRefs the serializer prints —
  // real accounts have duplicate campaign names, which names can't resolve.
  const refs = rowsWithAnalystRefs({
    platform,
    table: "campaign",
    rows: pd.byLevel?.campaign || [],
  });
  const campaigns = refs
    .filter(({ row }) => num(row.spend) > 0)
    .sort((a, b) => num(b.row.spend) - num(a.row.spend));
  const [top, second] = campaigns;
  if (!top) throw new Error("no spending campaigns in dataset");
  const conv = (c) => num(c.row.results ?? c.row.conversions);
  const cpa = (c) => (conv(c) > 0 ? num(c.row.spend) / conv(c) : null);

  const fact = (id, label, kind, value, computeOver = {}) => ({
    id,
    label,
    kind,
    value,
    op: "sum",
    platform,
    table: "campaign",
    rows: [top.rowRef],
    metric: "spend",
    numerator: "",
    denominator: "",
    scale: 0,
    referenceCpa: 0,
    formula: "",
    ...computeOver,
  });

  const facts = [
    fact("F-TOP-SPEND", "Top campaign spend", "observation", num(top.row.spend)),
    // deliberately wrong claimed value → verifier replaces with the real share
    fact("F-TOP-SHARE", "Top campaign spend share", "observation", 0, { op: "share" }),
    // poison pill #1 — fabricated 3× value, must be dropped
    fact("F-FABRICATED", "FABRICATED spend figure", "observation", num(top.row.spend) * 3),
    // poison pill #2 — an estimate can never be recoverable, must be demoted
    fact("F-ESTIMATE", "Projected savings if CPA halves", "recoverable", Math.round(num(top.row.spend) * 0.25), {
      op: "estimate",
      platform: "NONE",
      table: "",
      rows: [],
      metric: "",
      formula: "spend × 0.25 if CPA halves",
    }),
    ...(second
      ? [fact("F-SECOND-SPEND", "Second campaign spend", "observation", num(second.row.spend), { rows: [second.rowRef] })]
      : []),
  ];

  const findings = [
    {
      id: "AN-BUDGET-CONCENTRATION",
      title: `${top.row.name} carries the account`,
      severity: "HIGH",
      category: "budget",
      campaignRefs: [top.row.name],
      entityRefs: [top.rowRef],
      claim: `${top.row.name} accounts for the largest share of spend${cpa(top) != null ? ` at a CPA of ${Math.round(cpa(top))}` : ""}.`,
      factIds: ["F-TOP-SPEND", "F-TOP-SHARE", "F-FABRICATED", "F-ESTIMATE"],
      recommendation: `Hold ${top.row.name}'s budget and fix the weaker campaigns first.`,
      confidence: "high",
    },
    ...(second
      ? [
          {
            id: "AN-SECOND-CAMPAIGN",
            title: `${second.row.name} needs a decision`,
            severity: "MEDIUM",
            category: "structure",
            campaignRefs: [second.row.name],
            entityRefs: [second.rowRef],
            claim: `${second.row.name} spent a verified amount this period.`,
            factIds: ["F-SECOND-SPEND"],
            recommendation: `Review ${second.row.name}'s targeting against the account winner.`,
            confidence: "medium",
          },
        ]
      : []),
  ];

  // Merge the first rule finding into the first analyst finding (money
  // transfer path); confirm the rest.
  const ruleIds = [...new Set((audit.ruleFindings || []).map((f) => f.ruleId))];
  const ruleFindingDispositions = ruleIds.map((ruleId, i) => ({
    ruleId,
    disposition: i === 0 ? "merged" : "confirmed",
    note: "",
    mergedIntoFindingId: i === 0 ? "AN-BUDGET-CONCENTRATION" : "",
    factIds: [],
  }));

  return {
    executiveSummary:
      `This dry-run narrative was generated offline from the account's real rows: ${top.row.name} leads spend` +
      `${second ? ` with ${second.row.name} second` : ""}. It exists to prove the serialize → verify → merge → render pipeline on real data.`,
    executiveFactIds: [],
    rootCause:
      "Offline dry run — the root cause narrative comes from the live model in production.",
    rootCauseFactIds: [],
    facts,
    findings,
    campaignDeepDives: campaigns.slice(0, 3).map((c) => ({
      campaignName: c.row.name,
      campaignRef: c.rowRef,
      verdict: cpa(c) != null && cpa(top) != null && cpa(c) <= cpa(top) ? "keep" : "fix",
      diagnosis: `Spent ${Math.round(num(c.row.spend))} for ${conv(c)} conversions${cpa(c) != null ? ` (CPA ${Math.round(cpa(c))})` : ""}.`,
      actions: ["Dry-run action placeholder"],
      factIds: [],
    })),
    ruleFindingDispositions,
    recommendations: [
      {
        priority: 1,
        action: "Dry-run: verify pipeline end to end",
        expectedImpact: "Confidence before live run",
        factIds: [],
      },
    ],
  };
};

const main = async () => {
  const audits = await pickAudits();
  if (audits.length === 0) {
    console.log("No completed audits found.");
    return;
  }

  let failures = 0;
  for (const audit of audits) {
    const platform = audit.selectedPlatforms[0];
    const label = `${platform} ${audit.adAccount?.name || audit.id}`;
    console.log(`\n━━━ ${label} (${audit.id}) ━━━`);
    const bundle = { ...audit, uploadReadiness: calculateUploadReadiness(audit) };

    // 1. Real-data serialization (also proves the token budget on real accounts).
    const serialization = serializeDatasetForAnalyst(bundle, { maxTokens: 150000 });
    console.log(
      `  serializer: ${serialization.tableCount} tables, ≈${serialization.tokenEstimate} tokens, ` +
        `${serialization.truncations.length} truncations, currency ${serialization.currency}`
    );

    // 2. Full runAnalyst path with a stubbed model returning the synthetic report.
    const synthetic = syntheticAnalystReport(bundle, platform);
    const run = await runAnalyst(
      { audit: bundle },
      {
        createMessage: async (request) => {
          // messages[0].content is a block array (text + cache_control).
          const promptChars = (request.messages[0].content || [])
            .map((b) => (typeof b === "string" ? b : b.text || ""))
            .join("").length;
          console.log(
            `  request check: model=${request.model} schema=${!!request.output_config?.format?.schema} ` +
              `promptChars=${promptChars}`
          );
          return {
            content: [{ type: "text", text: JSON.stringify(synthetic) }],
            stop_reason: "end_turn",
            usage: { input_tokens: serialization.tokenEstimate, output_tokens: 2500 },
          };
        },
      }
    );

    // 3. Verification — the two poison pills must be caught.
    const verified = verifyAnalystReport({
      report: run.report,
      audit: bundle,
      quarantinedCampaigns: run.quarantinedCampaigns,
    });
    console.log(`  verification: ${JSON.stringify(verified.stats)}`);
    for (const d of verified.droppedFigures) {
      console.log(`    dropped: "${d.label}" claimed=${d.claimed} recomputed=${d.recomputed} (${d.reason})`);
    }
    const fabricatedDropped = verified.droppedFigures.some((d) => /FABRICATED/.test(d.label));
    const estimateDemoted = verified.stats.estimatesDemoted >= 1;
    if (!fabricatedDropped) {
      failures += 1;
      console.error("  ✗ FAIL: fabricated figure was NOT dropped");
    } else console.log("  ✓ fabricated figure dropped");
    if (!estimateDemoted) {
      failures += 1;
      console.error("  ✗ FAIL: recoverable estimate was NOT demoted");
    } else console.log("  ✓ recoverable estimate demoted to observation");

    // 4. Persist + render the merged premium report.
    const data = {
      provider: "dry-run",
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

    const fresh = await prisma.audit.findUnique({
      where: { id: audit.id },
      include: { ...include, analystReport: true },
    });
    const html = renderAuditPremiumReportHtml(
      { ...fresh, uploadReadiness: calculateUploadReadiness(fresh) },
      fresh.organization?.brandingSettings || {}
    );
    const hasNotes = html.includes("Campaign-by-campaign: what the numbers say");
    const hasMoves = html.includes("Priority moves, in order");
    const hasStory = html.includes("Account story:");
    console.log(
      `  render: ${Math.round(html.length / 1024)}kB — campaignNotes=${hasNotes} priorityMoves=${hasMoves} execStory=${hasStory}`
    );
    if (!hasNotes || !hasMoves || !hasStory) {
      failures += 1;
      console.error("  ✗ FAIL: analyst sections missing from rendered report");
    } else console.log("  ✓ analyst sections render in the report");

    const outPath = path.resolve(process.cwd(), "storage/pdf-reports", `analyst-dryrun-${audit.id}.html`);
    await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
    await fs.promises.writeFile(outPath, html, "utf8");
    console.log(`  wrote: ${outPath}`);

    // 5. Clean up the dry-run record so live runs start clean.
    await prisma.analystReport.delete({ where: { auditId: audit.id } }).catch(() => {});
    console.log("  cleaned up dry-run AnalystReport row");
  }

  console.log(failures === 0 ? "\nALL DRY-RUN CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  await prisma.$disconnect();
  if (failures > 0) process.exit(1);
};

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
