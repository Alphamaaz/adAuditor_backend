#!/usr/bin/env node
/**
 * Registry smoke test.
 *
 * Loads every rule, prints a summary, and runs invariant checks that should
 * never be violated. Exits non-zero on any violation so CI can gate on it.
 */
import { registry } from "../_registry.js";
import { MIGRATED_LEGACY_IDS } from "./diff-legacy-vs-registry.js";

const violations = [];

const main = async () => {
  await registry.ensureLoaded();
  const all = registry.getAll();
  console.log(`Loaded ${all.length} rule(s):`);
  for (const rule of all) {
    console.log(
      `  - ${rule.id}@${rule.version} [${rule.platforms.join(",")}] ` +
        `severity=${rule.severity} cost=${rule.costToEvaluate} ` +
        `minPlan=${rule.minPlanTier} legacy=${rule.legacyRuleId ?? "n/a"}`
    );
  }
  console.log(`\nfor META platform: ${registry.forPlatform("META").length}`);
  console.log(`for plan tier free: ${registry.forPlanTier("free").length}`);
  console.log(
    `for context version v1: ${registry.forContextVersion("v1").length}`
  );

  // ── Invariant checks ────────────────────────────────────────────────────
  console.log("\nRunning invariant checks…");

  // 1. Every rule must have a unique id (registry already enforces, but
  //    re-check defensively).
  const ids = all.map((r) => r.id);
  const dupIds = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupIds.length) violations.push(`Duplicate rule ids: ${dupIds.join(", ")}`);

  // 2. If a rule has a legacyRuleId, it must be unique too.
  const legacyIds = all.map((r) => r.legacyRuleId).filter(Boolean);
  const dupLegacy = legacyIds.filter((id, i) => legacyIds.indexOf(id) !== i);
  if (dupLegacy.length)
    violations.push(`Duplicate legacyRuleIds: ${dupLegacy.join(", ")}`);

  // 3. Every legacy ID we claim has been migrated (in MIGRATED_LEGACY_IDS)
  //    must be implemented by some rule with that legacyRuleId.
  const implementedLegacy = new Set(legacyIds);
  for (const legacy of MIGRATED_LEGACY_IDS) {
    if (!implementedLegacy.has(legacy)) {
      violations.push(
        `MIGRATED_LEGACY_IDS lists "${legacy}" but no rule has legacyRuleId="${legacy}"`
      );
    }
  }

  // 4. If a rule has a legacyRuleId, that legacy ID must be tracked in
  //    MIGRATED_LEGACY_IDS — otherwise the harness silently skips it.
  for (const rule of all) {
    if (rule.legacyRuleId && !MIGRATED_LEGACY_IDS.has(rule.legacyRuleId)) {
      violations.push(
        `Rule ${rule.id} declares legacyRuleId="${rule.legacyRuleId}" ` +
          `but it is NOT in MIGRATED_LEGACY_IDS. Add it to the harness.`
      );
    }
  }

  // 5. Every rule with requiresHistory must NOT have minPlanTier=free
  //    (history rules need continuous monitoring which is paid).
  for (const rule of all) {
    if (rule.requiresHistory && rule.minPlanTier === "free") {
      violations.push(
        `Rule ${rule.id} requiresHistory but minPlanTier=free; ` +
          `history rules should be gated to a paid tier.`
      );
    }
  }

  // 6. Category must match the platform category map (lightweight: not empty).
  for (const rule of all) {
    if (!rule.category || rule.category.length === 0) {
      violations.push(`Rule ${rule.id} has empty category`);
    }
  }

  if (violations.length) {
    console.error("\n✗ INVARIANT VIOLATIONS:");
    for (const v of violations) console.error("  - " + v);
    process.exit(1);
  }
  console.log("✓ All invariants hold.");
};

main().catch((err) => {
  console.error("Smoke test failed:", err);
  process.exit(1);
});
