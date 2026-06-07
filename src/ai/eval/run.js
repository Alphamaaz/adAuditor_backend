#!/usr/bin/env node
/**
 * Narrative eval runner.
 *
 * Default mode scores each fixture's referenceOutput against its evidence
 * packet and rubric. Live mode calls the configured AI provider and scores the
 * real response. Missing provider keys are skipped; provider/runtime failures
 * are failures so launch checks cannot pass on partially broken live output.
 */

import { fileURLToPath } from "node:url";
import { argv } from "node:process";

import fixtures from "./golden/index.js";
import { scoreReport } from "./rubric.js";
import { buildAiAuditContext } from "../../modules/audits/aiContext.service.js";

const LIVE = argv.includes("--live");

const pad = (s, n) => String(s).padEnd(n);
const padNum = (s, n) => String(s).padStart(n);

const isProviderUnconfigured = (error) =>
  Boolean(error?.details?.missingEnv) || /is not configured/i.test(error?.message || "");

const runFixture = async (fixture) => {
  const context = buildAiAuditContext(fixture.audit, {
    priorAudits: fixture.priorAudits || [],
  });
  const packet = context.evidencePacket;
  const findings = fixture.audit.ruleFindings || [];

  let output = fixture.referenceOutput;
  let mode = "reference";

  if (LIVE) {
    try {
      const { generateAiAuditReport } = await import(
        "../../modules/audits/aiProvider.service.js"
      );
      const result = await generateAiAuditReport({
        context,
        auditId: fixture.audit.id,
        purpose: "eval",
      });
      output = result.output;
      mode = `live:${result.provider}`;
    } catch (err) {
      const skipped = isProviderUnconfigured(err);
      return {
        name: fixture.name,
        mode: skipped ? "live-skipped" : "live-error",
        error: err?.message || String(err),
        result: null,
        skipped,
      };
    }
  }

  const result = scoreReport({
    output,
    packet,
    findings,
    expected: fixture.expected,
  });
  return { name: fixture.name, mode, result };
};

const main = async () => {
  console.log(
    `Narrative eval - ${fixtures.length} fixtures, mode: ${
      LIVE ? "LIVE" : "deterministic (referenceOutput)"
    }\n`
  );

  const header =
    pad("Fixture", 26) + pad("Mode", 14) + padNum("Total", 7) + "  Pass  Failures";
  console.log(header);
  console.log("-".repeat(header.length + 10));

  let allPass = true;
  let liveSkipped = 0;

  for (const fixture of fixtures) {
    const { name, mode, result, error, skipped } = await runFixture(fixture);
    if (!result) {
      if (skipped) {
        liveSkipped += 1;
        console.log(`${pad(name, 26)}${pad(mode, 14)}${padNum("-", 7)}  SKIP  ${error}`);
      } else {
        allPass = false;
        console.log(`${pad(name, 26)}${pad(mode, 14)}${padNum("-", 7)}  FAIL  ${error}`);
      }
      continue;
    }
    if (!result.pass) allPass = false;
    console.log(
      `${pad(name, 26)}${pad(mode, 14)}${padNum(result.total.toFixed(2), 7)}  ${
        result.pass ? " OK " : "FAIL"
      }  ${result.failures.slice(0, 2).join(" | ")}`
    );
  }

  console.log("");
  if (LIVE && liveSkipped === fixtures.length) {
    console.log(
      "All fixtures skipped (no AI key configured). Run without --live for the deterministic rubric check."
    );
    process.exit(0);
  }

  if (allPass) {
    console.log("All scored fixtures pass the rubric.");
    process.exit(0);
  }
  console.error("One or more fixtures failed the rubric.");
  process.exit(1);
};

const isDirect = argv[1] && fileURLToPath(import.meta.url) === argv[1];
if (isDirect) {
  main().catch((err) => {
    console.error("Eval runner failed:", err);
    process.exit(1);
  });
}

export { runFixture };
