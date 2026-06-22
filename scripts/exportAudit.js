/**
 * Corpus export tool for the finding-trust layer.
 *
 *   node scripts/exportAudit.js list            # list recent audits
 *   node scripts/exportAudit.js <auditId>       # dump one audit -> scripts/corpus/<id>.json
 *
 * Pulls the exact shape the rule engine consumes (normalizedDataset + intake +
 * businessProfileSnapshot) plus the findings that were produced, so each export
 * is a fully replayable regression-corpus entry.
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../src/lib/prisma.js";

const here = dirname(fileURLToPath(import.meta.url));
const arg = process.argv[2];

async function list() {
  const audits = await prisma.audit.findMany({
    orderBy: { createdAt: "desc" },
    take: 30,
    select: {
      id: true,
      status: true,
      selectedPlatforms: true,
      healthScore: true,
      createdAt: true,
      _count: { select: { ruleFindings: true } },
      normalizedDataset: { select: { id: true } },
    },
  });
  if (!audits.length) {
    console.log("No audits found in local DB.");
    return;
  }
  console.log(`\n${audits.length} most recent audits:\n`);
  for (const a of audits) {
    const hasData = a.normalizedDataset ? "data" : "NO-DATA";
    const when = a.createdAt.toISOString().slice(0, 16).replace("T", " ");
    console.log(
      `${a.id}  ${when}  ${String(a.status).padEnd(10)} ` +
        `${(a.selectedPlatforms || []).join(",").padEnd(18)} ` +
        `score=${a.healthScore ?? "-"} findings=${a._count.ruleFindings} ${hasData}`
    );
  }
  console.log("");
}

async function exportOne(id) {
  const audit = await prisma.audit.findUnique({
    where: { id },
    include: {
      normalizedDataset: true,
      intakeResponses: true,
      ruleFindings: true,
      adAccount: { select: { platform: true, externalId: true, name: true } },
    },
  });
  if (!audit) {
    console.error(`Audit ${id} not found.`);
    process.exitCode = 1;
    return;
  }
  const outDir = join(here, "corpus");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${id}.json`);
  writeFileSync(outPath, JSON.stringify(audit, null, 2));
  const ds = audit.normalizedDataset;
  console.log(`Exported -> ${outPath}`);
  console.log(`  platforms: ${(audit.selectedPlatforms || []).join(", ")}`);
  console.log(`  findings:  ${audit.ruleFindings.length}`);
  console.log(`  dataset:   ${ds ? "present" : "MISSING (CSV-only or pre-normalize?)"}`);
}

(async () => {
  try {
    if (!arg || arg === "list") await list();
    else await exportOne(arg);
  } catch (err) {
    console.error("Export failed:", err.message);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})();
