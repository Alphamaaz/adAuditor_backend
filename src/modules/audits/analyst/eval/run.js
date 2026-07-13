#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { argv, cwd, env, exit } from "node:process";
import { fileURLToPath } from "node:url";

import { runDeterministicAudit } from "../../auditEngine.service.js";
import { calculateUploadReadiness } from "../../uploadReadiness.service.js";
import { runAnalyst } from "../analystRun.service.js";
import { serializeDatasetForAnalyst } from "../datasetSerializer.js";
import { verifyAnalystReport } from "../analystVerification.service.js";
import { gradeAnalystTrial, summarizeFixtureTrials } from "./analystEval.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "../../../../..");
const defaultCorpusDir = path.join(projectRoot, "scripts", "corpus");

const parseArgs = (args) => {
  const options = {
    live: false,
    trials: 3,
    limit: Infinity,
    only: [],
    model: null,
    effort: null,
    maxOutputTokens: null,
    corpus: defaultCorpusDir,
    output: null,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = () => args[++index];
    if (arg === "--live") options.live = true;
    else if (arg === "--trials") options.trials = Number(next());
    else if (arg === "--limit") options.limit = Number(next());
    else if (arg === "--only") options.only = String(next() || "").split(",").filter(Boolean);
    else if (arg === "--model") options.model = next();
    else if (arg === "--effort") options.effort = next();
    else if (arg === "--max-output-tokens") options.maxOutputTokens = Number(next());
    else if (arg === "--corpus") options.corpus = path.resolve(cwd(), next());
    else if (arg === "--output") options.output = path.resolve(cwd(), next());
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(options.trials) || options.trials < 1 || options.trials > 10) {
    throw new Error("--trials must be an integer from 1 to 10");
  }
  if (!(options.limit > 0)) throw new Error("--limit must be greater than zero");
  if (options.effort && !["low", "medium", "high"].includes(options.effort)) {
    throw new Error("--effort must be low, medium, or high");
  }
  if (options.maxOutputTokens !== null && !(options.maxOutputTokens > 0)) {
    throw new Error("--max-output-tokens must be greater than zero");
  }
  return options;
};

const usage = () => {
  console.log(`Analyst evaluation harness

Free corpus preflight:
  npm run analyst:eval

Live multi-trial evaluation (paid Anthropic calls):
  npm run analyst:eval -- --live --trials 3

Options:
  --limit N          Evaluate the first N corpus audits
  --only ID[,ID]     Evaluate matching audit IDs or filenames
  --model MODEL      Override ANALYST_MODEL for this run
  --effort LEVEL     Override effort: low, medium, or high
  --max-output-tokens N  Override the generation ceiling
  --output PATH      Artifact directory (default: storage/eval-runs/<run-id>)
  --corpus PATH      Anonymized corpus directory under scripts/corpus
  --trials N         Trials per audit, 1-10 (default: 3)
`);
};

const json = (value) => JSON.stringify(value, null, 2);
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const writeJson = async (file, value) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, json(value), "utf8");
};
const hash = (value) => createHash("sha256").update(value).digest("hex");
const clone = (value) => structuredClone(value);
const safeName = (value) => String(value).replace(/[^a-zA-Z0-9_.-]+/g, "-");

const assertSafeCorpusPath = (corpusPath) => {
  const relative = path.relative(defaultCorpusDir, corpusPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `Refusing corpus outside ${defaultCorpusDir}. Anonymize and place fixtures there first.`
    );
  }
};

const assertAnonymized = (raw, file) => {
  const forbiddenEmail = [...raw.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)]
    .map((match) => match[0])
    .filter((email) => email.toLowerCase() !== "redacted@example.com");
  const forbiddenUrl = [...raw.matchAll(/https?:\/\/[^\s"']+/gi)]
    .map((match) => match[0])
    .filter((url) => !/^https?:\/\/example\.com\/?$/i.test(url));
  const namingFingerprint = /(\s\|\s)|(#\d{5,})/.test(raw);
  if (forbiddenEmail.length || forbiddenUrl.length || namingFingerprint) {
    throw new Error(
      `${file} appears to contain identifying data; run npm run analyst:corpus:anonymize first`
    );
  }
};

const loadCorpus = async (options) => {
  assertSafeCorpusPath(options.corpus);
  const files = (await readdir(options.corpus))
    .filter((file) => file.endsWith(".json") && !file.startsWith("_"))
    .sort();
  const fixtures = [];
  for (const file of files) {
    const raw = await readFile(path.join(options.corpus, file), "utf8");
    assertAnonymized(raw, file);
    const audit = JSON.parse(raw);
    const id = audit.id || path.basename(file, ".json");
    if (
      options.only.length > 0 &&
      !options.only.some((value) => value === id || value === file || value === path.basename(file, ".json"))
    ) {
      continue;
    }
    fixtures.push({ id, file, raw, sourceHash: hash(raw), audit });
    if (fixtures.length >= options.limit) break;
  }
  if (fixtures.length === 0) throw new Error("No matching anonymized corpus fixtures found");
  return fixtures;
};

const prepareAudit = (fixture) => {
  const audit = clone(fixture.audit);
  const deterministic = runDeterministicAudit(audit);
  audit.ruleFindings = deterministic.findings;
  audit.healthScore = deterministic.scores?.overall ?? null;
  audit.deterministicReport = deterministic.report;
  audit.uploadReadiness = calculateUploadReadiness(audit);
  return audit;
};

const preflightFixture = (fixture) => {
  const audit = prepareAudit(fixture);
  const serialization = serializeDatasetForAnalyst(audit);
  return {
    id: fixture.id,
    file: fixture.file,
    sourceHash: fixture.sourceHash,
    platforms: audit.selectedPlatforms || [],
    currency: serialization.currency,
    tables: serialization.tableCount,
    tokenEstimate: serialization.tokenEstimate,
    truncations: serialization.truncations.length,
    ruleFindings: audit.ruleFindings.length,
  };
};

const isSystemicConfigurationError = (error) => {
  const message = String(error?.message || error || "");
  return (
    [400, 401, 403, 404].includes(Number(error?.status)) ||
    /invalid_request_error|schema|optional properties|authentication|api key|model.*not found|max_tokens|truncated/i.test(
      message
    )
  );
};

const printPreflight = (results) => {
  console.log(`Analyst corpus preflight - ${results.length} anonymized audits\n`);
  console.log("Fixture                              Platform       Currency  Tables   Tokens  Rules  Trunc");
  console.log("-".repeat(94));
  for (const item of results) {
    console.log(
      `${item.id.slice(0, 36).padEnd(37)}${item.platforms.join("+").padEnd(15)}` +
        `${String(item.currency).padEnd(10)}${String(item.tables).padStart(6)}` +
        `${String(item.tokenEstimate).padStart(9)}${String(item.ruleFindings).padStart(7)}` +
        `${String(item.truncations).padStart(7)}`
    );
  }
};

const runLiveTrial = async ({ fixture, trialNumber, options, fixtureDir }) => {
  const trialDir = path.join(fixtureDir, `trial-${trialNumber}`);
  const startedAt = new Date().toISOString();
  const started = Date.now();
  try {
    const audit = prepareAudit(fixture);
    const run = await runAnalyst({
      audit,
      model: options.model || undefined,
      effort: options.effort || undefined,
      maxOutputTokens: options.maxOutputTokens || undefined,
      captureTrace: true,
    });
    const verified = verifyAnalystReport({
      report: run.report,
      audit,
      quarantinedCampaigns: run.quarantinedCampaigns,
    });
    const grade = gradeAnalystTrial({ audit, run, verified });
    const metadata = {
      trial: trialNumber,
      startedAt,
      durationMs: Date.now() - started,
      model: run.model,
      schemaVersion: run.schemaVersion,
      usage: run.usage,
      serialization: run.serialization,
      quarantinedCampaigns: run.quarantinedCampaigns,
    };
    await writeJson(path.join(trialDir, "provider-report.json"), run.providerReport);
    await writeJson(path.join(trialDir, "raw-report.json"), run.report);
    await writeJson(path.join(trialDir, "verified-report.json"), verified.report);
    await writeJson(path.join(trialDir, "transcript.json"), run.trace);
    await writeJson(path.join(trialDir, "verification.json"), {
      stats: verified.stats,
      droppedFigures: verified.droppedFigures,
      droppedClaims: verified.droppedClaims,
    });
    await writeJson(path.join(trialDir, "grade.json"), grade);
    await writeJson(path.join(trialDir, "metadata.json"), metadata);
    return { metadata, grade, verified };
  } catch (error) {
    const failure = {
      trial: trialNumber,
      startedAt,
      durationMs: Date.now() - started,
      error: error?.message || String(error),
      stack: error?.stack || null,
      systemic: isSystemicConfigurationError(error),
      usage: error?.usage || null,
      stopReason: error?.stopReason || null,
    };
    if (error?.trace) await writeJson(path.join(trialDir, "transcript.json"), error.trace);
    if (error?.partialResponse) {
      await writeJson(path.join(trialDir, "partial-response.json"), error.partialResponse);
    }
    await writeJson(path.join(trialDir, "error.json"), failure);
    return { error: failure };
  }
};

const liveRun = async (fixtures, options) => {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is required for --live evaluation");
  }
  const runId = `analyst-live-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const outputDir = options.output || path.join(projectRoot, "storage", "eval-runs", runId);
  await mkdir(outputDir, { recursive: true });
  const summary = {
    runId,
    startedAt: new Date().toISOString(),
    mode: "live",
    model: options.model || env.ANALYST_MODEL || "default",
    effort: options.effort || env.ANALYST_EFFORT || "high",
    maxOutputTokens:
      options.maxOutputTokens || Number(env.ANALYST_MAX_OUTPUT_TOKENS) || 64000,
    trialsPerFixture: options.trials,
    corpus: path.relative(projectRoot, options.corpus),
    fixtures: [],
    totals: { inputTokens: 0, outputTokens: 0, completedTrials: 0, failedTrials: 0 },
  };

  console.log(
    `Analyst LIVE eval - ${fixtures.length} audits x ${options.trials} trials = ` +
      `${fixtures.length * options.trials} paid model runs\nArtifacts: ${outputDir}\n`
  );

  for (const fixture of fixtures) {
    const fixtureDir = path.join(outputDir, safeName(fixture.id));
    const trials = [];
    console.log(`${fixture.id} (${fixture.audit.selectedPlatforms?.join("+") || "unknown"})`);
    for (let trialNumber = 1; trialNumber <= options.trials; trialNumber += 1) {
      process.stdout.write(`  trial ${trialNumber}/${options.trials} ... `);
      const trial = await runLiveTrial({ fixture, trialNumber, options, fixtureDir });
      trials.push(trial);
      if (trial.grade) {
        summary.totals.completedTrials += 1;
        summary.totals.inputTokens += num(trial.metadata.usage.inputTokens);
        summary.totals.outputTokens += num(trial.metadata.usage.outputTokens);
        console.log(`${trial.grade.pass ? "PASS" : "FAIL"} ${trial.grade.total.toFixed(3)}`);
      } else {
        summary.totals.failedTrials += 1;
        summary.totals.inputTokens += num(trial.error.usage?.inputTokens);
        summary.totals.outputTokens += num(trial.error.usage?.outputTokens);
        console.log(`ERROR ${trial.error.error}`);
        if (trial.error.systemic) {
          summary.aborted = true;
          summary.abortReason = trial.error.error;
          console.log("  Systemic configuration error detected; aborting remaining paid trials.");
          break;
        }
      }
    }
    const fixtureSummary = summarizeFixtureTrials(trials);
    const fixtureResult = {
      id: fixture.id,
      file: fixture.file,
      sourceHash: fixture.sourceHash,
      platforms: fixture.audit.selectedPlatforms || [],
      ...fixtureSummary,
    };
    summary.fixtures.push(fixtureResult);
    await writeJson(path.join(fixtureDir, "summary.json"), fixtureResult);
    console.log(
      `  => ${fixtureResult.pass ? "PASS" : "FAIL"}; pass@k=${fixtureResult.passAtK} ` +
        `pass^k=${fixtureResult.passPowK} consistency=${fixtureResult.consistency.pass}\n`
    );
    if (summary.aborted) break;
  }

  summary.completedAt = new Date().toISOString();
  summary.pass =
    !summary.aborted &&
    summary.fixtures.length === fixtures.length &&
    summary.fixtures.every((fixture) => fixture.pass);
  await writeJson(path.join(outputDir, "summary.json"), summary);
  console.log(
    `Input tokens: ${summary.totals.inputTokens}; output tokens: ${summary.totals.outputTokens}`
  );
  console.log(summary.pass ? "All live fixtures passed." : "One or more live fixtures failed.");
  return summary;
};

const main = async () => {
  const options = parseArgs(argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  const fixtures = await loadCorpus(options);
  const preflight = fixtures.map(preflightFixture);
  printPreflight(preflight);
  if (!options.live) {
    console.log("\nPreflight passed. Add --live to make paid multi-trial model calls.");
    return;
  }
  const summary = await liveRun(fixtures, options);
  if (!summary.pass) exit(1);
};

const isDirect = argv[1] && fileURLToPath(import.meta.url) === path.resolve(argv[1]);
if (isDirect) {
  main().catch((error) => {
    console.error(`Analyst eval failed: ${error?.message || error}`);
    exit(1);
  });
}

export { loadCorpus, parseArgs, preflightFixture, prepareAudit };
