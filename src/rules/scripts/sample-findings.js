#!/usr/bin/env node
/**
 * Produces one sample finding per money rule against the large-account
 * fixture. For the brand rules, injects brandTerms into the business
 * profile so they have a chance to fire.
 *
 * Usage: node src/rules/scripts/sample-findings.js
 */

import { registry } from "../_registry.js";
import { buildLargeAccountContext } from "../__fixtures__/large-account.js";
import { AuditContextSchema } from "../schemas/context.schema.js";

const MONEY_RULES = [
  "GOOGLE-SEARCH-TERM-WASTE-001",
  "GOOGLE-BRAND-SEPARATION-001",
  "META-AUDIENCE-OVERLAP-001",
  "META-CAPI-MATCH-001",
  "COMPOUND-BRAND-CANNIBALIZATION-001",
];

const main = async () => {
  await registry.ensureLoaded();

  // Base ctx already has lookalike + interest intake signals to exercise overlap.
  // Inject brandTerms + CAPI status so brand + CAPI rules can fire.
  const base = buildLargeAccountContext();
  const enriched = AuditContextSchema.parse({
    ...base,
    audit: {
      ...base.audit,
      businessProfileSnapshot: {
        ...base.audit.businessProfileSnapshot,
        sectionA: {
          ...(base.audit.businessProfileSnapshot?.sectionA ?? {}),
          brandTerms: ["acme", "swoosh"],
        },
      },
      intakeResponses: base.audit.intakeResponses.map((r) =>
        r.section === "PLATFORM_META"
          ? {
              ...r,
              answers: {
                ...r.answers,
                M12: "yes",
                M13: "many stacked broad interests",
                M_CAPI_STATUS: "deployed",
                M_CAPI_MATCH_RATE: 62,
              },
            }
          : r
      ),
    },
  });

  for (const id of MONEY_RULES) {
    const rule = registry.getById(id);
    if (!rule) {
      console.log(`\n=== ${id} ===\n(NOT REGISTERED)`);
      continue;
    }
    const finding = rule.eval(enriched);
    console.log(`\n=== ${id} ===`);
    if (!finding) {
      console.log("(did not fire on the enriched large-account fixture)");
      continue;
    }
    // Trim evidence for readability
    const trimmedEvidence = JSON.parse(JSON.stringify(finding.evidence));
    if (Array.isArray(trimmedEvidence.examples)) {
      trimmedEvidence.examples = trimmedEvidence.examples.slice(0, 3);
    }
    console.log(
      JSON.stringify(
        {
          ruleId: finding.ruleId,
          platform: finding.platform,
          severity: finding.severity,
          category: finding.category,
          title: finding.title,
          detail: finding.detail,
          evidence: trimmedEvidence,
          estimatedImpact: finding.estimatedImpact,
          fixSteps: finding.fixSteps,
        },
        null,
        2
      )
    );
  }
};

main().catch((err) => {
  console.error("Sample findings failed:", err);
  process.exit(1);
});
