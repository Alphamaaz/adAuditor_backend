/**
 * Anonymise the regression corpus in place so it is safe to commit.
 *
 *   node scripts/anonymizeCorpus.js [--check]
 *
 * Strips client-identifying strings (campaign / ad-set / ad / account / business
 * names, external IDs, emails, URLs) while PRESERVING everything the trust-layer
 * invariants depend on: all numbers, the per-segment dimension values
 * (age/placement/device/region brackets), currency, businessType, and structure.
 * A consistent name → pseudonym map keeps referential integrity (the same
 * campaign maps to the same "Campaign 3" everywhere) so overlap reconciliation
 * still groups correctly.
 *
 * `--check` exits non-zero if any file still contains a value under a sensitive
 * key — a guard you can run before committing.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const corpusDir = join(here, "corpus");
const checkOnly = process.argv.includes("--check");

// Keys whose string VALUES name a real entity/account/business → pseudonymise.
const NAME_KEYS = new Set([
  "name", "entity", "campaign", "adName", "adSet", "adGroup", "adgroup",
  "worstEntity", "bestEntity", "worstCampaign", "bestCampaign", "accountName",
]);
// Keys that may carry free-text / contact / brand identifiers anywhere in the tree.
const SCRUB_KEY_RX = /(name|company|business|brand|website|url|email|domain|owner|client|contact|address|phone)/i;
// Keys we must NOT touch — the engine's logic reads these and the dimension
// segment labels are categorical, not PII.
const KEEP_KEYS = new Set([
  "segment", "dimension", "platform", "businessType", "currency", "level",
  "reason", "sampleNote", "ruleId", "severity", "category", "section",
]);

const counters = new Map();
const mapping = new Map();
const label = (kind) => {
  const n = (counters.get(kind) || 0) + 1;
  counters.set(kind, n);
  return `${kind} ${n}`;
};
const pseudonym = (kind, value) => {
  const key = `${kind}::${value}`;
  if (!mapping.has(key)) mapping.set(key, label(kind));
  return mapping.get(key);
};

const looksSensitive = (key) => SCRUB_KEY_RX.test(key) && !KEEP_KEYS.has(key);

// A `segment` value is categorical (age bracket, placement, device, region,
// weekday) and must be kept — EXCEPT audience names/IDs, which are advertiser-
// chosen identifiers. Scrub those (they carry '#', 'CUSTOM_AUDIENCE',
// 'LOOKALIKE', or the '|' campaign-derived naming) and keep the rest.
const AUDIENCE_LIKE_RX = /#|custom_audience|lookalike|saved_audience|\|/i;

// Audience identifiers (advertiser-chosen names / IDs).
const AUDIENCE_KEYS = new Set(["audienceLabel", "audienceSegment", "audienceName"]);

const scrubString = (key, value) => {
  if (typeof value !== "string" || !value.trim()) return value;
  if (key === "segment") {
    return AUDIENCE_LIKE_RX.test(value) ? pseudonym("Audience", value) : value;
  }
  if (AUDIENCE_KEYS.has(key)) return pseudonym("Audience", value);
  if (/criterionId|audienceId|adsetId|adSetId|adGroupId|campaignId|adId/i.test(key)) return "ANON_ID";
  if (KEEP_KEYS.has(key)) return value;
  if (key === "externalId" || /external/i.test(key)) return "act_ANON";
  if (/email/i.test(key)) return "redacted@example.com";
  if (/website|url|domain/i.test(key)) return "https://example.com";
  if (NAME_KEYS.has(key)) return pseudonym("Campaign", value);
  if (looksSensitive(key)) return pseudonym("Entity", value);
  return value;
};

// The corpus only needs what the deterministic engine consumes. Dropping the
// stored ruleFindings / AI report / PDF relations both slims the files and
// removes the biggest free-text leak vector (their titles/details embed real
// campaign + audience names).
const ENGINE_INPUT_KEYS = [
  "id", "selectedPlatforms", "dataSource", "uploadReadiness",
  "businessProfileSnapshot", "intakeResponses", "normalizedDataset",
];
const projectToEngineInputs = (audit) => {
  const out = {};
  for (const k of ENGINE_INPUT_KEYS) if (k in audit) out[k] = audit[k];
  return out;
};

const walk = (node, parentKey = "") => {
  if (Array.isArray(node)) return node.map((v) => walk(v, parentKey));
  if (node && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === "string") out[k] = scrubString(k, v);
      else out[k] = walk(v, k);
    }
    return out;
  }
  return node;
};

// Value-based leak scan — catches the real account's naming fingerprints in ANY
// string value regardless of which key holds it: pipe-delimited campaign names
// ("Display | PK | Signals | …") and audience IDs ("#2488177887755"). Audience
// TYPE enums (CUSTOM_AUDIENCE / LOOKALIKE) are categorical — every account has
// them — and region names / age brackets / placements / weekdays are categorical
// too, so they're allowed.
const LEAK_RX = /(\s\|\s)|(#\d{5,})/;
const SENSITIVE_VALUE_CHECK = (obj) => {
  const hits = [];
  const rec = (n) => {
    if (Array.isArray(n)) return n.forEach(rec);
    if (n && typeof n === "object") return Object.values(n).forEach(rec);
    if (typeof n === "string" && LEAK_RX.test(n)) hits.push(JSON.stringify(n).slice(0, 60));
  };
  rec(obj);
  return hits;
};

const files = readdirSync(corpusDir).filter((f) => f.endsWith(".json"));
let problems = 0;
for (const file of files) {
  const path = join(corpusDir, file);
  const data = JSON.parse(readFileSync(path, "utf8"));
  if (checkOnly) {
    const hits = SENSITIVE_VALUE_CHECK(data);
    if (hits.length) {
      problems += hits.length;
      console.log(`✗ ${file}: ${hits.length} sensitive value(s) e.g. ${hits.slice(0, 3).join(", ")}`);
    } else {
      console.log(`✓ ${file}: clean`);
    }
    continue;
  }
  // Reset the per-file maps so pseudonyms are stable WITHIN a file (referential
  // integrity for grouping) but not linkable ACROSS files.
  counters.clear();
  mapping.clear();
  const anon = walk(projectToEngineInputs(data));
  const remaining = SENSITIVE_VALUE_CHECK(anon);
  writeFileSync(path, JSON.stringify(anon, null, 2));
  console.log(`anonymised ${file}${remaining.length ? ` — ⚠ ${remaining.length} value(s) still match leak patterns` : ""}`);
}

if (checkOnly && problems > 0) {
  console.error(`\n${problems} sensitive value(s) remain — corpus is NOT safe to commit.`);
  process.exit(1);
}
if (checkOnly) console.log("\nCorpus is clean.");
