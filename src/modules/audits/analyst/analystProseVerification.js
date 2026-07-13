import { analystRowDisplayName } from "./analystRowRef.js";

const CURRENCY_CODES = [
  "USD",
  "PKR",
  "EUR",
  "GBP",
  "CAD",
  "AUD",
  "AED",
  "INR",
  "SAR",
  "QAR",
  "KWD",
  "SGD",
  "MYR",
  "THB",
  "PHP",
  "IDR",
  "BDT",
  "LKR",
  "NPR",
  "ZAR",
];

const NUMBER_RX = new RegExp(
  `(?<![A-Za-z0-9_])(?:${CURRENCY_CODES.join("|")}\\s*|[$€£]\\s*)?(-?\\d[\\d,]*(?:\\.\\d+)?)(?:\\s*(%|x|×))?(?![A-Za-z0-9_])`,
  "gi"
);

const num = (value) => {
  const parsed = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
};

const withinTolerance = (claimed, verified) => {
  const a = num(claimed);
  const b = num(verified);
  if (a === null || b === null) return false;
  return Math.abs(a - b) <= Math.max(Math.abs(b) * 0.015, 0.01);
};

const escapeRegExp = (value) =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Exact entity labels may legitimately contain numbers (for example "Lead Gen 2"). */
export const collectAnalystEntityLabels = (audit) => {
  const labels = new Set();
  const platforms = audit?.normalizedDataset?.data?.platforms || {};
  for (const pd of Object.values(platforms)) {
    const tables = [
      ...Object.values(pd?.byLevel || {}),
      ...Object.values(pd?.byDimension || {}),
      pd?.byDay || [],
    ];
    for (const rows of tables) {
      for (const row of Array.isArray(rows) ? rows : []) {
        const label = analystRowDisplayName(row);
        if (label !== null && label !== undefined && String(label).trim()) {
          labels.add(String(label).trim());
        }
      }
    }
  }
  return [...labels].sort((a, b) => b.length - a.length);
};

const withoutEntityLabels = (text, entityLabels) => {
  let scrubbed = String(text || "");
  for (const label of entityLabels || []) {
    if (!/\d/.test(label)) continue;
    scrubbed = scrubbed.replace(new RegExp(escapeRegExp(label), "gi"), " ");
  }
  // Dates, clock labels, attribution-window labels, and anonymized entity
  // sequence numbers identify rows/settings; they are not quantitative claims.
  scrubbed = scrubbed
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ")
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ")
    .replace(/\b\d+-(?:day|week|month)(?:-[a-z]+)?\b/gi, " ")
    .replace(
      /\b(?:campaign|entity|ad\s*set|ad\s*group)\s+\d+(?:\s*,\s*\d+)*(?:\s+(?:and|&)\s+\d+)?/gi,
      " "
    );
  return scrubbed;
};

export const numericClaimsIn = (text, { entityLabels = [] } = {}) => {
  const scrubbed = withoutEntityLabels(text, entityLabels);
  return [...scrubbed.matchAll(NUMBER_RX)].map((match) => ({
    raw: match[0],
    value: num(match[1]),
    decimals: (String(match[1]).split(".")[1] || "").length,
    suffix: match[2] || null,
  }));
};

/**
 * Dataset-pool matching is PRECISION-AWARE, not tolerance-based: the claim
 * must equal the dataset value rounded to the claim's own printed precision
 * ("12,428" backs 12427.65; "60.92" backs 60.92475), or be an explicitly
 * round number within tolerance ("12,400" for 12427.65). A blanket 1.5%
 * tolerance would let invented near-misses ride real values — "PKR 99,999"
 * must NOT be vouched for by a true 100,000 total; a model citing the real
 * number writes the real number.
 */
const datasetValueMatches = (claim, value) => {
  const claimed = num(claim.value);
  const actual = num(value);
  if (claimed === null || actual === null) return false;
  const decimals = Math.min(Number(claim.decimals) || 0, 6);
  const factor = 10 ** decimals;
  if (Math.abs(Math.round(actual * factor) / factor - claimed) < 1 / factor / 2) {
    return true;
  }
  const isRoundNumber =
    Number.isInteger(claimed) && claimed !== 0 && claimed % 10 === 0;
  return isRoundNumber && withinTolerance(claimed, actual);
};

const verifiedValues = (figures) =>
  (figures || [])
    .filter((figure) => figure?.verified === true && Number.isFinite(Number(figure.value)))
    .map((figure) => Number(figure.value));

const sentencesOf = (text) =>
  String(text || "")
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean) || [];

const METRIC_NUMERIC_KEYS = [
  "spend",
  "impressions",
  "clicks",
  "conversions",
  "results",
  "revenue",
  "conversionsValue",
  "budget",
  "dailyBudget",
  "lifetimeBudget",
  "cpa",
  "cpc",
  "cpm",
  "ctr",
  "cvr",
  "roas",
  "frequency",
  "reach",
  "targetCpa",
  "qualityScore",
];

const pushDerivedRatios = (pool, { spend, impressions, clicks, conversions }) => {
  if (spend > 0 && conversions > 0) pool.push(spend / conversions);
  if (spend > 0 && clicks > 0) pool.push(spend / clicks);
  if (spend > 0 && impressions > 0) pool.push((spend / impressions) * 1000);
  if (clicks > 0 && impressions > 0) pool.push((clicks / impressions) * 100);
  if (conversions > 0 && clicks > 0) pool.push((conversions / clicks) * 100);
};

/**
 * Every number the dataset can VOUCH FOR without a model-attached fact:
 * raw cell values, per-row derived ratios (CPA/CPC/CPM/CTR/CVR), per-table
 * aggregate totals with the same ratios, summary totals, and table row COUNTS
 * ("all 4 campaigns" is a claim about table length, not a metric).
 *
 * This pool exists because sentence deletion is the wrong response to a TRUE
 * number the model simply didn't cite — the first live eval amputated the
 * executive summary's (correct) account totals, a campaign's budget-column
 * value, and two row counts. Attached-figure verification stays the rigorous
 * channel; this is the safety net for prose.
 */
export const collectDatasetNumericPool = (audit) => {
  const pool = [0];
  const platforms = audit?.normalizedDataset?.data?.platforms || {};
  for (const pd of Object.values(platforms)) {
    const tables = [
      ...Object.values(pd?.byLevel || {}),
      ...Object.values(pd?.byDimension || {}),
      pd?.byDay || [],
    ];
    for (const rows of tables) {
      if (!Array.isArray(rows) || rows.length === 0) continue;
      pool.push(rows.length); // row count claims ("all 4 campaigns")
      const totals = { spend: 0, impressions: 0, clicks: 0, conversions: 0 };
      for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        for (const key of METRIC_NUMERIC_KEYS) {
          const value = Number(row[key]);
          if (Number.isFinite(value) && value !== 0) pool.push(value);
        }
        const spend = Number(row.spend) || 0;
        const impressions = Number(row.impressions) || 0;
        const clicks = Number(row.clicks) || 0;
        const conversions = Number(row.results ?? row.conversions) || 0;
        totals.spend += spend;
        totals.impressions += impressions;
        totals.clicks += clicks;
        totals.conversions += conversions;
        pushDerivedRatios(pool, { spend, impressions, clicks, conversions });
      }
      for (const value of Object.values(totals)) if (value > 0) pool.push(value);
      pushDerivedRatios(pool, totals);
    }
  }
  const summary = audit?.normalizedDataset?.summary || {};
  const summaryObjects = [summary.totals, ...Object.values(summary.platforms || {})];
  for (const obj of summaryObjects) {
    if (!obj || typeof obj !== "object") continue;
    for (const key of METRIC_NUMERIC_KEYS) {
      const value = Number(obj[key]);
      if (Number.isFinite(value) && value !== 0) pool.push(value);
    }
    pushDerivedRatios(pool, {
      spend: Number(obj.spend) || 0,
      impressions: Number(obj.impressions) || 0,
      clicks: Number(obj.clicks) || 0,
      conversions: Number(obj.results ?? obj.conversions) || 0,
    });
  }
  return pool;
};

/**
 * Keep only sentences whose numeric claims are backed by a verified figure —
 * on the same object, anywhere in the report (`reportPool`), or derivable
 * directly from the dataset (`datasetPool`). Non-numeric prose passes
 * unchanged.
 *
 * `prescriptive: true` marks fields that PROPOSE values (recommended budgets,
 * caps) rather than describe measurements — a proposal can't be recomputed
 * from data by definition, so unsupported numbers there are kept and counted,
 * never dropped. Outcome claims (expectedImpact) stay strict.
 */
export const sanitizeNumericProse = ({
  text,
  figures = [],
  reportPool = [],
  datasetPool = [],
  entityLabels = [],
  prescriptive = false,
  path,
} = {}) => {
  const original = String(text || "").trim();
  if (!original) return { text: "", dropped: [], prescriptiveUnsupported: [] };

  const allowed = [...verifiedValues(figures), ...reportPool];
  const supported = (claim) =>
    allowed.some((value) => withinTolerance(claim.value, value)) ||
    datasetPool.some((value) => datasetValueMatches(claim, value));
  const kept = [];
  const dropped = [];
  const prescriptiveUnsupported = [];
  for (const sentence of sentencesOf(original)) {
    const claims = numericClaimsIn(sentence, { entityLabels });
    const unsupported = claims.filter((claim) => !supported(claim));
    if (unsupported.length === 0) {
      kept.push(sentence);
    } else if (prescriptive) {
      kept.push(sentence);
      prescriptiveUnsupported.push({ path, sentence, unsupported });
    } else {
      dropped.push({ path, sentence, unsupported });
    }
  }

  return { text: kept.join(" ").trim(), dropped, prescriptiveUnsupported };
};

/**
 * Pre-flight for the repair turn: the strict-field sentences whose numbers no
 * CLAIMED fact or dataset value supports. Runs before verification (claimed
 * values, not verified ones) — its only job is deciding what to ask the model
 * to back up; verification remains the authority on what survives.
 */
export const findUnsupportedProse = (report, { datasetPool = [], entityLabels = [] } = {}) => {
  const claimedValues = (figures) =>
    (figures || [])
      .map((figure) => Number(figure?.value))
      .filter((value) => Number.isFinite(value));
  const allFigures = [
    ...(report?.executiveFigures || []),
    ...(report?.rootCauseFigures || []),
    ...(report?.findings || []).flatMap((f) => f.figures || []),
    ...(report?.campaignDeepDives || []).flatMap((d) => d.figures || []),
    ...(report?.recommendations || []).flatMap((r) => r.figures || []),
    ...(report?.ruleFindingDispositions || []).flatMap((d) => d.figures || []),
  ];
  const reportPool = claimedValues(allFigures);
  const unsupported = [];
  const check = (text, path) => {
    for (const sentence of sentencesOf(String(text || "").trim())) {
      const missing = numericClaimsIn(sentence, { entityLabels }).filter(
        (claim) =>
          !reportPool.some((value) => withinTolerance(claim.value, value)) &&
          !datasetPool.some((value) => datasetValueMatches(claim, value))
      );
      if (missing.length > 0) unsupported.push({ path, sentence, unsupported: missing });
    }
  };
  check(report?.executiveSummary, "executiveSummary");
  check(report?.rootCause, "rootCause");
  (report?.findings || []).forEach((f, i) => {
    check(f.title, `findings[${i}].title`);
    check(f.claim, `findings[${i}].claim`);
  });
  (report?.campaignDeepDives || []).forEach((d, i) => {
    check(d.diagnosis, `campaignDeepDives[${i}].diagnosis`);
  });
  (report?.recommendations || []).forEach((r, i) => {
    check(r.expectedImpact, `recommendations[${i}].expectedImpact`);
  });
  (report?.ruleFindingDispositions || []).forEach((d, i) => {
    check(d.note, `ruleFindingDispositions[${i}].note`);
  });
  return unsupported;
};
