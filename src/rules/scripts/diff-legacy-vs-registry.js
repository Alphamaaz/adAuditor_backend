#!/usr/bin/env node
/**
 * Snapshot/equivalence harness for the rule engine migration.
 *
 * Runs the legacy auditEngine.service.js AND the new registry against the
 * same set of synthetic audit contexts, then asserts equivalent rule-owned
 * findings for every rule that has been migrated. Engine-wide trust metadata
 * is removed before comparison because it is applied after legacy rule
 * evaluation and is not owned by an individual registry rule.
 *
 * Usage:
 *   npm run rules:diff
 *
 * Exit code 0 = no drift. Exit code 1 = drift detected (CI gate).
 *
 * As rules migrate, add their `legacyRuleId` to MIGRATED_LEGACY_IDS below.
 */

import { fileURLToPath } from "node:url";
import { argv } from "node:process";

import { registry } from "../_registry.js";
import { runDeterministicAudit } from "../../modules/audits/auditEngine.service.js";

// Add a legacyRuleId here once a rule is migrated and should be diffed.
export const MIGRATED_LEGACY_IDS = new Set([
  "DATA-001",
  "AUD-001",
  "AUD-003",
  "STR-006",
  "CRE-001",
]);

const FROZEN_NOW = "2026-05-26T12:00:00.000Z";

const buildAuditFromContext = (ctx) => ({
  ...ctx.audit,
  normalizedDataset: ctx.dataset,
});

const buildFixtures = () => [
  {
    name: "meta-no-data",
    ctx: {
      audit: {
        id: "fx1",
        selectedPlatforms: ["META"],
        businessProfileSnapshot: { sectionA: {}, sectionB: {}, sectionC: {} },
        intakeResponses: [{ section: "PLATFORM_META", answers: {} }],
      },
      dataset: {
        summary: {
          totals: {},
          platforms: { META: { uploadedFiles: 0, rowCount: 0, spend: 0 } },
        },
        data: { platforms: { META: { records: [] } } },
      },
      priorAudits: [],
      now: FROZEN_NOW,
    },
  },
  {
    name: "meta-all-intake-flags-set",
    ctx: {
      audit: {
        id: "fx2",
        selectedPlatforms: ["META"],
        businessProfileSnapshot: { sectionA: {}, sectionB: {}, sectionC: {} },
        intakeResponses: [
          {
            section: "PLATFORM_META",
            answers: {
              M5: "no",
              M6: "No",
              M7: 12,
              M8: "monthly refresh",
            },
          },
        ],
      },
      dataset: {
        summary: {
          totals: {},
          platforms: { META: { uploadedFiles: 1, rowCount: 1, spend: 100 } },
        },
        data: {
          platforms: {
            META: {
              records: [{ level: "campaign", name: "Test", spend: 100 }],
            },
          },
        },
      },
      priorAudits: [],
      now: FROZEN_NOW,
    },
  },
  {
    name: "meta-clean-intake",
    ctx: {
      audit: {
        id: "fx3",
        selectedPlatforms: ["META"],
        businessProfileSnapshot: { sectionA: {}, sectionB: {}, sectionC: {} },
        intakeResponses: [
          {
            section: "PLATFORM_META",
            answers: { M5: "yes", M6: "yes", M7: 5, M8: "weekly" },
          },
        ],
      },
      dataset: {
        summary: {
          totals: {},
          platforms: { META: { uploadedFiles: 1, rowCount: 1, spend: 100 } },
        },
        data: {
          platforms: {
            META: {
              records: [{ level: "campaign", name: "Test", spend: 100 }],
            },
          },
        },
      },
      priorAudits: [],
      now: FROZEN_NOW,
    },
  },
];

const stableSortFindings = (findings) =>
  [...findings].sort((a, b) => {
    if (a.ruleId !== b.ruleId) return a.ruleId.localeCompare(b.ruleId);
    return (a.platform || "").localeCompare(b.platform || "");
  });

const canonicalizeRuleFinding = (finding) => {
  const { rootCause, evidence, ...ruleFinding } = finding;
  const {
    trust: _trust,
    netRecoverable: _netRecoverable,
    ...ruleEvidence
  } = evidence || {};

  // Legacy findings now receive a nullable rootCause and trust-layer evidence
  // after rule evaluation. Preserve meaningful root causes, but ignore the
  // post-processing defaults that registry rules never produce themselves.
  return {
    ...ruleFinding,
    ...(rootCause ? { rootCause } : {}),
    evidence: ruleEvidence,
  };
};

const filterMigrated = (findings) =>
  findings.filter((f) => MIGRATED_LEGACY_IDS.has(f.ruleId));

const runLegacy = (ctx) => {
  const audit = buildAuditFromContext(ctx);
  const { findings } = runDeterministicAudit(audit);
  return stableSortFindings(filterMigrated(findings).map(canonicalizeRuleFinding));
};

const runRegistry = async (ctx) => {
  await registry.ensureLoaded();
  const findings = [];
  for (const rule of registry.getAll()) {
    if (!rule.legacyRuleId) continue;
    if (!MIGRATED_LEGACY_IDS.has(rule.legacyRuleId)) continue;
    try {
      const result = rule.eval(ctx);
      if (result) findings.push(result);
    } catch (err) {
      console.error(`Rule ${rule.id} threw:`, err);
      throw err;
    }
  }
  return stableSortFindings(findings.map(canonicalizeRuleFinding));
};

const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const diffFindings = (legacy, registryFindings) => {
  if (deepEqual(legacy, registryFindings)) return null;
  return {
    legacyOnly: legacy.filter(
      (lf) => !registryFindings.some((rf) => deepEqual(lf, rf))
    ),
    registryOnly: registryFindings.filter(
      (rf) => !legacy.some((lf) => deepEqual(lf, rf))
    ),
  };
};

const main = async () => {
  const fixtures = buildFixtures();
  let drift = false;

  for (const fixture of fixtures) {
    const legacy = runLegacy(fixture.ctx);
    const registryFindings = await runRegistry(fixture.ctx);
    const diff = diffFindings(legacy, registryFindings);
    if (diff) {
      drift = true;
      console.error(`\n✗ DRIFT in fixture "${fixture.name}":`);
      console.error("  legacyOnly:", JSON.stringify(diff.legacyOnly, null, 2));
      console.error(
        "  registryOnly:",
        JSON.stringify(diff.registryOnly, null, 2)
      );
    } else {
      console.log(
        `✓ ${fixture.name}: ${legacy.length} migrated finding(s) match`
      );
    }
  }

  if (drift) {
    console.error("\nRule engine drift detected. Aborting.");
    process.exit(1);
  } else {
    console.log("\nAll migrated rules match legacy engine output.");
    process.exit(0);
  }
};

const isDirectInvocation =
  argv[1] && fileURLToPath(import.meta.url) === argv[1];

if (isDirectInvocation) {
  main().catch((err) => {
    console.error("Harness failed:", err);
    process.exit(1);
  });
}
