#!/usr/bin/env node
/**
 * Per-rule performance harness.
 *
 * Runs the entire registry against the large-account fixture N times,
 * collects timing per rule, and asserts each rule's p95 is within its
 * declared costToEvaluate budget.
 *
 * Output: a summary table with p50, p95, max, fired/passed counts, and
 * a pass/fail verdict per rule.
 *
 * Exit codes:
 *   0 — all rules within budget
 *   1 — at least one rule exceeded its budget (only when PERF_HARNESS_STRICT=true)
 *
 * Usage:
 *   node src/rules/scripts/perf-harness.js
 *   PERF_HARNESS_STRICT=true node src/rules/scripts/perf-harness.js
 *   PERF_HARNESS_ITERATIONS=20 node src/rules/scripts/perf-harness.js
 */

import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { argv } from "node:process";

import { registry } from "../_registry.js";
import { buildLargeAccountContext } from "../__fixtures__/large-account.js";

// Per-rule p95 budgets in ms, indexed by `costToEvaluate`.
export const COST_BUDGETS_MS = {
  cheap: 50,
  moderate: 500,
  expensive: 5000,
};

const STRICT = String(process.env.PERF_HARNESS_STRICT || "").toLowerCase() === "true";
const ITERATIONS = Number(process.env.PERF_HARNESS_ITERATIONS || 10);

const percentile = (sortedAsc, p) => {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.ceil((p / 100) * sortedAsc.length) - 1
  );
  return sortedAsc[Math.max(0, idx)];
};

const pad = (s, n) => String(s).padEnd(n);
const padNum = (s, n) => String(s).padStart(n);

const main = async () => {
  await registry.ensureLoaded();
  const rules = registry.getAll();
  console.log(`Performance harness — ${rules.length} rule(s), ${ITERATIONS} iteration(s)`);
  console.log("Fixture: large-account (~5K entities, all 3 platforms)\n");

  const ctx = buildLargeAccountContext();
  // Per-rule timing samples
  const samples = new Map();
  const counts = new Map();

  for (const rule of rules) {
    samples.set(rule.id, []);
    counts.set(rule.id, { fired: 0, passed: 0, errored: 0 });
  }

  for (let i = 0; i < ITERATIONS; i++) {
    for (const rule of rules) {
      const start = performance.now();
      let result = null;
      try {
        result = rule.eval(ctx);
      } catch (err) {
        const c = counts.get(rule.id);
        c.errored += 1;
      }
      const elapsed = performance.now() - start;
      samples.get(rule.id).push(elapsed);
      if (result) counts.get(rule.id).fired += 1;
      else counts.get(rule.id).passed += 1;
    }
  }

  const rows = [];
  let overBudget = 0;

  for (const rule of rules) {
    const sampleList = samples.get(rule.id).slice().sort((a, b) => a - b);
    const p50 = percentile(sampleList, 50);
    const p95 = percentile(sampleList, 95);
    const max = sampleList[sampleList.length - 1] || 0;
    const budget = COST_BUDGETS_MS[rule.costToEvaluate] ?? 50;
    const withinBudget = p95 <= budget;
    if (!withinBudget) overBudget += 1;
    const c = counts.get(rule.id);
    rows.push({
      id: rule.id,
      cost: rule.costToEvaluate,
      budget,
      p50: p50.toFixed(3),
      p95: p95.toFixed(3),
      max: max.toFixed(3),
      fired: c.fired,
      passed: c.passed,
      errored: c.errored,
      verdict: withinBudget ? "OK" : "OVER",
    });
  }

  // Render table
  const header =
    pad("Rule", 38) +
    pad("Cost", 11) +
    padNum("Budget", 8) +
    padNum("p50", 9) +
    padNum("p95", 9) +
    padNum("Max", 9) +
    padNum("Fired", 7) +
    padNum("Passed", 8) +
    padNum("Err", 5) +
    "  Verdict";
  console.log(header);
  console.log("-".repeat(header.length));
  for (const r of rows) {
    console.log(
      pad(r.id, 38) +
        pad(r.cost, 11) +
        padNum(r.budget + "ms", 8) +
        padNum(r.p50, 9) +
        padNum(r.p95, 9) +
        padNum(r.max, 9) +
        padNum(r.fired, 7) +
        padNum(r.passed, 8) +
        padNum(r.errored, 5) +
        "  " +
        r.verdict
    );
  }

  console.log("");
  console.log(`Rules within budget: ${rules.length - overBudget}/${rules.length}`);
  console.log(`Strict mode: ${STRICT ? "ON (fail on overage)" : "OFF (report only)"}`);

  if (overBudget > 0) {
    console.error(`\n✗ ${overBudget} rule(s) exceeded their p95 budget.`);
    if (STRICT) process.exit(1);
  } else {
    console.log("\n✓ All rules within p95 budget.");
  }
};

const isDirectInvocation =
  argv[1] && fileURLToPath(import.meta.url) === argv[1];

if (isDirectInvocation) {
  main().catch((err) => {
    console.error("Perf harness failed:", err);
    process.exit(1);
  });
}
