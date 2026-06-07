#!/usr/bin/env node
/**
 * Rule inventory report.
 *
 * Maps the production legacy engine (auditEngine.service.js) against the
 * registry (src/rules/**) so launch reviewers can see exactly what is
 * production vs shadow, what's migrated, and what only exists in one place.
 *
 * Read-only. Run: npm run rules:inventory
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { registry } from "../_registry.js";
import { MIGRATED_LEGACY_IDS } from "./diff-legacy-vs-registry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.join(__dirname, "../../modules/audits/auditEngine.service.js");
const COMPARISON = path.join(
  __dirname,
  "../../modules/audits/comparisonFindings.service.js"
);

const ruleIdsFrom = (file) => {
  const src = readFileSync(file, "utf8");
  const ids = new Set();
  for (const m of src.matchAll(/ruleId:\s*"([A-Z0-9-]+)"/g)) ids.add(m[1]);
  return ids;
};

const main = async () => {
  await registry.ensureLoaded();

  const legacyIds = ruleIdsFrom(ENGINE);
  const comparisonIds = ruleIdsFrom(COMPARISON);
  const registryRules = registry.getAll();
  const registryLegacyMap = new Map(
    registryRules.filter((r) => r.legacyRuleId).map((r) => [r.legacyRuleId, r.id])
  );

  const migrated = [...MIGRATED_LEGACY_IDS].sort();
  const registryOnlyNew = registryRules
    .filter((r) => !r.legacyRuleId)
    .map((r) => r.id)
    .sort();
  const legacyOnly = [...legacyIds]
    .filter((id) => !registryLegacyMap.has(id))
    .sort();

  console.log("═══ RULE INVENTORY ═══\n");

  console.log(`PRODUCTION ENGINE: legacy auditEngine.service.js (source of truth)`);
  console.log(`  Legacy rule IDs: ${legacyIds.size}`);
  console.log(`  ${[...legacyIds].sort().join(", ")}\n`);

  console.log(`REGISTRY (src/rules/**): ${registryRules.length} rule files`);
  console.log(`  ${registryRules.map((r) => r.id).sort().join(", ")}`);
  console.log(`  Execution: SHADOW (dual-write telemetry) — not production reads.\n`);

  console.log(`MIGRATED (legacy → registry, byte-equivalence gated in rules:diff): ${migrated.length}`);
  console.log(`  ${migrated.join(", ")}\n`);

  console.log(`REGISTRY-ONLY NEW (money rules; shadow only, no legacy equivalent): ${registryOnlyNew.length}`);
  console.log(`  ${registryOnlyNew.join(", ")}\n`);

  console.log(`LEGACY-ONLY (production; not yet in registry): ${legacyOnly.length}`);
  console.log(`  ${legacyOnly.join(", ")}\n`);

  console.log(`COMPARISON FINDINGS (emitted in pipeline, outside the legacy engine): ${comparisonIds.size}`);
  console.log(`  ${[...comparisonIds].sort().join(", ")}`);
  console.log(`  Source: comparisonFindings.service.js (peer + memory), persisted as findings.\n`);

  console.log("PARITY STATUS:");
  console.log(`  • The ${migrated.length} migrated rules are byte-equivalence tested in 'npm run rules:diff'.`);
  console.log(`  • Registry runs in shadow; flipping to production requires full parity across ALL legacy rules — NOT done.`);
  console.log(`  • Recommendation: keep legacy as production source of truth for launch.`);
};

const isDirect = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirect) {
  main().catch((err) => {
    console.error("Inventory failed:", err);
    process.exit(1);
  });
}

export { ruleIdsFrom };
