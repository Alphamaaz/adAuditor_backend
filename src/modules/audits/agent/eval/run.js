/**
 * Deep Audit — eval / smoke runner. (spec: docs/DEEP_AUDIT_SPEC.md → Eval requirements)
 *
 *   npm run deep:eval         run all golden fixtures
 *   npm run deep:smoke        run one fixture (the Essa-vs-Umeed case)
 *   node …/eval/run.js --only cpm-driven --limit 2
 *
 * With ANTHROPIC_API_KEY set (+ `@anthropic-ai/sdk` installed) it runs the REAL
 * agentic loop and scores whether the conclusion reaches the right root cause,
 * printing token cost. Without a key it runs the DETERMINISTIC fixture check so
 * the script is always useful (and CI-safe). Exits non-zero on any failure.
 */

import process from "node:process";
import { DEEP_AUDIT_FIXTURES } from "./fixtures.js";
import { createDeepAuditTools } from "../tools.js";
import { runDeepAudit } from "../orchestrator.js";
import { computeCostUsd } from "../../aiUsage.service.js";
import { DEEP_AUDIT_MODEL } from "../config.js";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const only = flag("--only");
const limit = Number(flag("--limit")) || Infinity;

let fixtures = DEEP_AUDIT_FIXTURES;
if (only) fixtures = fixtures.filter((f) => f.name === only);
fixtures = fixtures.slice(0, limit);

if (fixtures.length === 0) {
  console.error(`No fixtures matched${only ? ` --only ${only}` : ""}.`);
  process.exit(1);
}

const deterministicSignal = (fx) => {
  const tools = createDeepAuditTools({ audit: fx.audit, priorAudits: fx.priorAudits });
  if (fx.signal.tool === "analyzeSegments") {
    return tools.analyzeSegments().headline?.worst?.segment;
  }
  return tools.decomposeKpi({ kpi: fx.kpi }).decomposition?.dominantDriver;
};

const expectedOf = (fx) => fx.signal.dominantDriver || fx.signal.segment;

const runDeterministic = () => {
  console.log("Running DETERMINISTIC fixture check (no live model calls).");
  console.log("(With ANTHROPIC_API_KEY set + `npm i @anthropic-ai/sdk`, this runs the live agentic loop.)\n");
  let pass = 0;
  for (const fx of fixtures) {
    const got = deterministicSignal(fx);
    const want = expectedOf(fx);
    const ok = String(got) === String(want);
    if (ok) pass += 1;
    console.log(`${ok ? "✓" : "✗"} ${fx.name}: ${fx.signal.tool} → ${got} (expected ${want})`);
  }
  console.log(`\n${pass}/${fixtures.length} fixtures' deterministic signal correct.`);
  process.exit(pass === fixtures.length ? 0 : 1);
};

const scoreConclusion = (fx, report) => {
  if (!report) return false;
  const text = [report.headline, report.rootCause, report.drivers]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return fx.keywords.some((k) => text.includes(k.toLowerCase()));
};

const runLive = async () => {
  console.log(`Deep Audit LIVE eval — ${fixtures.length} fixture(s), model ${DEEP_AUDIT_MODEL}\n`);
  const fallback = async () => ({ report: null, reason: "fallback" });
  let pass = 0;
  let totalCost = 0;

  for (const fx of fixtures) {
    let result;
    try {
      result = await runDeepAudit({ audit: fx.audit, priorAudits: fx.priorAudits, fallback });
    } catch (err) {
      console.log(`✗ ${fx.name}: ERROR ${err?.message || err}\n`);
      continue;
    }

    const reason = String(result.reason || "");
    if (reason.includes("@anthropic-ai/sdk") || reason.includes("Cannot find module")) {
      console.log("\n✗ @anthropic-ai/sdk is not installed. Run: npm i @anthropic-ai/sdk\n");
      process.exit(1);
    }

    const cost = computeCostUsd({
      model: DEEP_AUDIT_MODEL,
      inputTokens: result.usage?.inputTokens || 0,
      outputTokens: result.usage?.outputTokens || 0,
    });
    totalCost += cost;

    const reached = result.mode === "deep" && scoreConclusion(fx, result.report);
    if (reached) pass += 1;

    console.log(`${reached ? "PASS" : "FAIL"}  ${fx.name}  [mode=${result.mode}]`);
    if (result.report) {
      console.log(`   headline  : ${result.report.headline}`);
      console.log(`   rootCause : ${result.report.rootCause}`);
      console.log(`   confidence: ${result.report.confidence}`);
    } else {
      console.log(`   (fell back: ${result.reason})`);
    }
    console.log(`   tools     : ${(result.reasoningTrace || []).map((t) => t.tool).join(" → ") || "(none)"}`);
    console.log(`   tokens    : in ${result.usage?.inputTokens || 0} / out ${result.usage?.outputTokens || 0}  ≈ $${cost.toFixed(4)}`);
    console.log(`   expected  : "${expectedOf(fx)}" — keywords [${fx.keywords.join(", ")}]\n`);
  }

  console.log("──────────────────────────────────────────");
  console.log(`${pass}/${fixtures.length} reached the correct root cause.  Total ≈ $${totalCost.toFixed(4)}`);
  process.exit(pass === fixtures.length ? 0 : 1);
};

const sdkAvailable = async () => {
  try {
    await import("@anthropic-ai/sdk");
    return true;
  } catch {
    return false;
  }
};

const main = async () => {
  if (process.env.ANTHROPIC_API_KEY && (await sdkAvailable())) {
    await runLive();
    return;
  }
  if (process.env.ANTHROPIC_API_KEY) {
    console.log(
      "ANTHROPIC_API_KEY is set, but @anthropic-ai/sdk is not installed.\n" +
        "Run `npm i @anthropic-ai/sdk` to run the live agentic loop. " +
        "Falling back to the deterministic check.\n"
    );
  }
  runDeterministic();
};

main();
