import { byLeverageDesc } from "../../lib/findings/priority.js";
import { reconcileRecoverable } from "../../lib/findings/recoverable.js";
import { parseMoney } from "../../lib/money.js";
import { getBenchmark } from "./auditEngine.service.js";

const platformDocLabels = {
  GOOGLE: "google_ads",
  META: "meta_ads",
  TIKTOK: "tiktok_ads",
};

const platformLabels = {
  GOOGLE: "Google Ads",
  META: "Meta Ads",
  TIKTOK: "TikTok Ads",
};

const severityWeight = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
const easeWeight = { easy: 3, medium: 2, hard: 1 };

export const reportDocumentJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["masthead", "key_numbers", "executive_summary", "sections", "action_plan", "method_notes"],
  properties: {
    masthead: { type: "object" },
    key_numbers: { type: "array", minItems: 3, maxItems: 4 },
    executive_summary: { type: "object" },
    sections: { type: "array" },
    action_plan: { type: "object" },
    method_notes: { type: "array" },
  },
};

const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

// Real currency codes only — NOT a loose case-insensitive `[A-Z]{3}`, which
// matched any 3-letter word before a number ("from 21%" → a phantom "21"),
// pulling rate-only findings into the money map.
// Shared global currency vocabulary — see src/lib/money.js. Kept as a thin
// wrapper so the report parses money identically to the engine + trust layer.
const moneyMagnitude = (value) => {
  if (value === null || value === undefined) return 0;
  return parseMoney(value);
};

// The recoverable dollars attributable to ONE finding. Once a finding has passed
// through the trust layer it carries an authored, non-overlapping
// `evidence.netRecoverable` — prefer it so the money-map bars and per-finding
// labels show the same figures that sum to the headline (overlapping "secondary"
// findings net to 0 and drop out). Findings that never went through the trust
// layer (legacy/synthetic) fall back to parsing the estimatedImpact text.
const findingRecoverable = (finding) => {
  const net = finding?.evidence?.netRecoverable;
  if (Number.isFinite(net)) return net;
  return moneyMagnitude(finding?.estimatedImpact || finding?.evidence);
};

const formatMoney = (value, currency = "USD") => {
  const rounded = Math.round(num(value));
  const formatted = rounded.toLocaleString("en-US");
  return `${String(currency || "USD").toUpperCase()} ${formatted}`;
};

// A diagnostic finding (e.g. DIAG-CPA-001) explains WHY a metric misses target;
// it carries no recoverable dollar, and its narrative references a target value
// that must never be parsed as recovered money.
const isDiagnostic = (finding) => finding?.evidence?.diagnostic === true;

const impactLabel = (finding, currency = "USD") => {
  if (isDiagnostic(finding)) return "Optimization";
  // A delivery block is restorable upside, not recovered waste — label it
  // distinctly so it never reads as part of the "recoverable" total. (Its money
  // lives in the estimatedImpact text, not in netRecoverable.)
  if (finding.evidence?.blocksDelivery === true) {
    const blocked = moneyMagnitude(finding.estimatedImpact || finding.evidence);
    if (blocked > 0) return `${formatMoney(blocked, currency)} blocked`;
  }
  // An overlapping ("secondary") finding is the same spend already counted by the
  // primary finding — never show it as additional recoverable money.
  if (finding.evidence?.trust?.role === "secondary") return "Same spend (counted above)";
  if (finding.evidence?.trust?.verdict === "DIRECTIONAL") return "Directional — verify";
  const amount = findingRecoverable(finding);
  if (amount > 0) {
    return `${formatMoney(amount, currency)} recoverable`;
  }
  const text = String(finding.estimatedImpact || "").trim();
  const context = `${finding.title || ""} ${finding.detail || ""} ${text}`;
  if (/not quantified|impact not quantifiable|not safely quantifiable/i.test(text)) {
    if (/paused|inactive|zero impression|keyword/i.test(context)) return "Account hygiene risk";
    if (/brand/i.test(context)) return "Brand risk";
    if (/tracking|pixel|capi/i.test(context)) return "Tracking risk";
    return "Business risk";
  }
  if (!text) {
    if (/paused|inactive|zero impression|keyword/i.test(context)) return "Account hygiene risk";
    if (/brand/i.test(context)) return "Brand risk";
    if (/tracking|pixel|capi/i.test(context)) return "Tracking risk";
    return "Needs review";
  }
  if (text.length <= 42) return text;
  if (/brand/i.test(context)) return "Brand risk";
  if (/keyword|impression|paused|inactive/i.test(context)) return "Account hygiene risk";
  if (/tracking|pixel|capi/i.test(context)) return "Tracking risk";
  return "Needs review";
};

const titleize = (value) =>
  String(value ?? "")
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (c) => c.toUpperCase());

const cleanReportText = (value) =>
  titleize(value)
    .replace(/\bDay Of Week\b/g, "Day of week")
    .replace(/\bCpa\b/g, "CPA")
    .replace(/\bCtr\b/g, "CTR")
    .replace(/\bCpc\b/g, "CPC")
    .replace(/\bRoas\b/g, "ROAS")
    .replace(/\b(Pkr|Usd|Eur|Gbp|Aed|Inr|Cad|Aud|Nzd|Sgd|Sar|Try|Jpy|Zar)\b/g, (m) =>
      m.toUpperCase()
    );

const cleanSegmentValue = (value) => {
  const text = String(value ?? "").replace(/[_-]+/g, " ").trim();
  if (/^[A-Z][A-Z\s]+$/.test(text)) return text.toLowerCase().replace(/^./, (c) => c.toUpperCase());
  return cleanReportText(text);
};

const escapePlain = (value, fallback = "") =>
  String(value ?? fallback)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const scoreBand = (score) => {
  if (score >= 90) return "Excellent";
  if (score >= 75) return "Good";
  if (score >= 55) return "Fair";
  if (score >= 35) return "Poor";
  return "Critical";
};

const getCurrency = (audit) => {
  const summary = audit.normalizedDataset?.summary || {};
  const platforms = summary.platforms || {};
  for (const platform of Object.values(platforms)) {
    if (platform?.currency) return platform.currency;
  }
  return summary.totals?.currency || "USD";
};

const getTotals = (audit) => {
  const summary = audit.normalizedDataset?.summary || {};
  const totals = summary.totals || {};
  if (totals.spend || totals.impressions || totals.clicks || totals.conversions) return totals;
  const data = audit.normalizedDataset?.data || {};
  const byPlatform = data.byPlatform || {};
  return Object.values(byPlatform).reduce(
    (acc, platform) => {
      const s = platform.summary || {};
      acc.spend += num(s.spend);
      acc.impressions += num(s.impressions);
      acc.clicks += num(s.clicks);
      acc.conversions += num(s.conversions ?? s.results);
      return acc;
    },
    { spend: 0, impressions: 0, clicks: 0, conversions: 0 }
  );
};

/**
 * The reporting window for the masthead. Derives the true start→end range from
 * the normalized records' own date stamps (Meta/Google insights carry
 * date_start/date_stop); falls back to the audit's lookback window so the cover
 * never prints a single bare date in place of a period.
 */
const getPeriod = (audit) => {
  const platforms = audit.normalizedDataset?.data?.platforms || {};
  let minStart = null;
  let maxEnd = null;
  for (const platform of Object.values(platforms)) {
    for (const record of platform?.records || []) {
      if (record?.dateStart && (!minStart || record.dateStart < minStart)) minStart = record.dateStart;
      if (record?.dateEnd && (!maxEnd || record.dateEnd > maxEnd)) maxEnd = record.dateEnd;
    }
  }
  const fallbackEnd = audit.completedAt || audit.updatedAt || null;
  if (minStart && maxEnd) return { start: minStart, end: maxEnd };

  // No per-record dates: reconstruct the window from the lookback setting.
  const lookbackDays = audit.businessProfileSnapshot?.sectionA?.lookbackDays;
  const end = maxEnd || fallbackEnd;
  if (lookbackDays && end) {
    const endDate = new Date(end);
    if (!Number.isNaN(endDate.getTime())) {
      const startDate = new Date(endDate);
      startDate.setDate(startDate.getDate() - lookbackDays);
      return { start: startDate.toISOString().slice(0, 10), end };
    }
  }
  return { start: minStart, end };
};

const findingConfidence = (finding) => {
  const raw = String(finding.evidence?.confidence || "").toLowerCase();
  if (["high", "medium", "low"].includes(raw)) return raw;
  if (String(finding.evidence?.sampleNote || "").toLowerCase().includes("low")) return "low";
  return finding.severity === "CRITICAL" || finding.severity === "HIGH" ? "high" : "medium";
};

const findingEase = (finding) => {
  const text = `${finding.title || ""} ${finding.detail || ""}`.toLowerCase();
  if (text.includes("tracking") || text.includes("pixel") || text.includes("capi")) return "hard";
  return Array.isArray(finding.fixSteps) && finding.fixSteps.length > 3 ? "medium" : "easy";
};

// Leverage order: severity / root-cause gravity first (byLeverageDesc already
// bands severity → confidence → recoverable dollars), then ease as a final
// tiebreak. A rate-severe CRITICAL leads a larger-dollar MEDIUM — it must NOT be
// ordered by raw dollars (the old behaviour, which buried criticals).
export const sortFindingsForReport = (findings = []) =>
  [...findings].sort((a, b) => {
    const lev = byLeverageDesc(a, b);
    if (lev !== 0) return lev;
    const ease = easeWeight[findingEase(b)] - easeWeight[findingEase(a)];
    if (ease !== 0) return ease;
    return (severityWeight[b.severity] || 0) - (severityWeight[a.severity] || 0);
  });

const categoryScoreRows = (audit) => {
  const scores = audit.categoryScores || {};
  const rows = [];
  const walk = (value, path = []) => {
    if (typeof value === "number" && value >= 0 && value <= 100) {
      const last = path[path.length - 1];
      if (/^(overall|score|findingCount)$/i.test(last || "")) return;
      const categoryIndex = path.findIndex((p) => p === "categories");
      const labelPath = categoryIndex >= 0 ? path.slice(categoryIndex + 1) : path;
      const label = labelPath.join(" ");
      rows.push({ label: label || "Score", value });
      return;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    Object.entries(value).forEach(([key, child]) => walk(child, [...path, key]));
  };
  walk(scores);
  return rows
    .filter((row) => row.label && !/^platforms$/i.test(row.label))
    .slice(0, 10)
    .map(({ label, value }) => ({
      label: cleanReportText(label),
      value,
      max: 100,
      tone: value < 85 ? "warn" : "brand",
      display: String(value),
    }));
};

const hiddenEvidenceKeys = new Set(["id", "ruleId", "rule_id", "module", "version", "currency", "dimension"]);

const evidenceValue = (key, value, currency) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (/pct|percent|rate/i.test(key)) return `${Number(value.toFixed(1)).toLocaleString("en-US")}%`;
    if (/(spend|waste|cost|cpa|cpc|budget|revenue|impact|recoverable)/i.test(key)) return formatMoney(value, currency);
    return Math.round(value).toLocaleString("en-US");
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (/segment|day|network|device|placement|reason/i.test(key)) return cleanSegmentValue(value);
  return String(value);
};

const isShortEvidenceValue = (value) => {
  const text = String(value || "").trim();
  if (!text || text.length > 24) return false;
  if (/\.\s+\S/.test(text)) return false;
  if (text.split(/\s+/).filter(Boolean).length > 6) return false;
  return true;
};

const evidenceRows = (finding, currency = "USD", proseContext = "") => {
  const evidence = finding.evidence && typeof finding.evidence === "object" ? finding.evidence : {};
  const rows = Object.entries(evidence)
    .filter(([key, value]) =>
      value !== null &&
      value !== undefined &&
      typeof value !== "object" &&
      !hiddenEvidenceKeys.has(key) &&
      !key.startsWith("_") &&
      !key.startsWith("internal_") &&
      !key.startsWith("raw_")
    )
    .map(([metric, value]) => ({
      metric: cleanReportText(metric),
      value: evidenceValue(metric, value, currency),
      highlight: moneyMagnitude(value) > 0 || /confidence/i.test(metric),
    }))
    .filter((row) => isShortEvidenceValue(row.value))
    .filter((row) => !proseContext || !proseContext.includes(row.value));
  const amount = moneyMagnitude(finding.estimatedImpact || finding.evidence);
  if (amount > 0) rows.unshift({ metric: "Recoverable spend", value: formatMoney(amount, currency), highlight: true });
  return rows.slice(0, 6);
};

const pickFirstNumber = (source, keys) => {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const match = value.match(/([\d,]+(?:\.\d+)?)/);
      if (match) {
        const parsed = Number(match[1].replace(/,/g, ""));
        if (Number.isFinite(parsed)) return parsed;
      }
    }
  }
  return null;
};

const chartForFinding = (finding, currency = "USD") => {
  const e = finding.evidence || {};
  if (e.currentCtr && e.peerCtr) {
    return {
      type: "comparison_bars",
      rows: [
        { label: "This account CTR", value: num(e.currentCtr), max: Math.max(num(e.currentCtr), num(e.peerCtr)), tone: "warn", display: `${e.currentCtr}%` },
        { label: "Peer CTR", value: num(e.peerCtr), max: Math.max(num(e.currentCtr), num(e.peerCtr)), tone: "brand", display: `${e.peerCtr}%` },
      ],
      annotation: e.ctrGapPct ? { text: `${e.ctrGapPct}% gap` } : undefined,
    };
  }
  if (e.currentCpa && e.previousCpa) {
    return {
      type: "comparison_bars",
      rows: [
        { label: "Current CPA", value: num(e.currentCpa), max: Math.max(num(e.currentCpa), num(e.previousCpa)), tone: "warn", display: formatMoney(e.currentCpa, currency) },
        { label: "Previous CPA", value: num(e.previousCpa), max: Math.max(num(e.currentCpa), num(e.previousCpa)), tone: "brand", display: formatMoney(e.previousCpa, currency) },
      ],
    };
  }
  const segmentCpa = pickFirstNumber(e, [
    "segmentCpa",
    "segmentCPA",
    "segmentCost",
    "segmentCostPerConversion",
    "currentCpa",
    "currentCPA",
    "actualCpa",
    "actualCPA",
    "cpa",
  ]);
  const baselineCpa = pickFirstNumber(e, [
    "baselineCpa",
    "baselineCPA",
    "accountBaselineCpa",
    "accountBaselineCPA",
    "benchmarkCpa",
    "benchmarkCPA",
    "targetCpa",
    "targetCPA",
  ]);
  if (segmentCpa && baselineCpa) {
    const max = Math.max(segmentCpa, baselineCpa);
    return {
      type: "comparison_bars",
      rows: [
        { label: `${cleanSegmentValue(e.segment || e.dimension || "Segment")} CPA`, value: segmentCpa, max, tone: "warn", display: formatMoney(segmentCpa, currency) },
        { label: "Baseline CPA", value: baselineCpa, max, tone: "brand", display: formatMoney(baselineCpa, currency) },
      ],
      annotation: moneyMagnitude(finding.estimatedImpact) ? { text: impactLabel(finding, currency) } : undefined,
    };
  }
  const wasted = pickFirstNumber(e, [
    "estimatedWaste",
    "wastedSpend",
    "lossMakingSpend",
    "recoverableSpend",
  ]) || moneyMagnitude(finding.estimatedImpact);
  const spend = pickFirstNumber(e, ["spend", "segmentSpend", "totalSpend"]);
  if (wasted && spend && spend >= wasted) {
    return {
      type: "composition_bar",
      segments: [
        { label: "Recoverable", pct: Math.round((wasted / spend) * 1000) / 10, tone: "warn" },
        { label: "Remaining", pct: Math.max(0, Math.round((100 - (wasted / spend) * 100) * 10) / 10), tone: "brand" },
      ],
      caption: `${impactLabel(finding, currency)} within the affected spend pool.`,
    };
  }
  if (Array.isArray(e.rows) && e.rows.length >= 2 && e.rows.length <= 12) {
    return {
      type: "bar_chart_v",
      rows: e.rows.slice(0, 12).map((r) => ({
        label: String(r.label ?? r.segment ?? ""),
        value: num(r.value ?? r.spend ?? r.cpa),
        max: Math.max(...e.rows.map((x) => num(x.value ?? x.spend ?? x.cpa))),
        tone: "warn",
        display: String(r.display ?? r.value ?? r.spend ?? r.cpa),
      })),
      caption: finding.title,
    };
  }
  return null;
};

// Value↔reference pairs we can turn into a benchmarked proof row with a verdict.
// Each finding's evidence carries a measured value and the reference it should be
// judged against; pairing them is what makes a claim "proven" rather than asserted.
const PROOF_METRICS = [
  {
    label: "Cost per acquisition",
    valueKeys: ["actualCpa", "segmentCpa", "campaignCpa", "geoCpa", "audienceCpa", "cpa"],
    refKeys: ["targetCpa", "baselineCpa", "benchmarkCpa", "accountBaselineCpa"],
    dir: "lower",
    fmt: (x, c) => formatMoney(x, c),
  },
  {
    label: "Click-through rate",
    valueKeys: ["currentCtr", "ctr"],
    refKeys: ["peerCtr", "benchmarkCtr"],
    dir: "higher",
    fmt: (x) => `${Number(x).toFixed(2)}%`,
  },
  {
    label: "Return on ad spend",
    valueKeys: ["actualRoas", "roas"],
    refKeys: ["targetRoas"],
    dir: "higher",
    fmt: (x) => `${Number(x).toFixed(2)}x`,
  },
  {
    label: "Search impression share",
    valueKeys: ["searchImpressionShare"],
    refKeys: [],
    dir: "higher_abs",
    fmt: (x) => `${Number(x).toFixed(1)}%`,
  },
];

const firstNumberKey = (evidence, keys) =>
  keys.find((k) => typeof evidence[k] === "number" && Number.isFinite(evidence[k]));

/**
 * Build the benchmarked proof rows for a finding: the measured metric, the
 * reference it's judged against, and a pass/watch/fail verdict. Returns [] when
 * the finding carries no value↔reference pair (those keep the plain table).
 */
const findingProofRows = (finding, currency) => {
  const e = finding.evidence && typeof finding.evidence === "object" ? finding.evidence : {};
  const rows = [];
  for (const def of PROOF_METRICS) {
    const vKey = firstNumberKey(e, def.valueKeys);
    if (!vKey) continue;
    const v = e[vKey];

    // Absolute-threshold metric (e.g. impression share) — no paired reference.
    if (def.dir === "higher_abs") {
      let status = "good";
      let label = "Healthy";
      if (v < 30) { status = "bad"; label = "Low coverage"; }
      else if (v < 60) { status = "warn"; label = "Room to grow"; }
      rows.push({ metric: def.label, value: def.fmt(v, currency), target: "≥ 60%", status, statusLabel: label });
      continue;
    }

    const rKey = firstNumberKey(e, def.refKeys);
    if (!rKey || e[rKey] <= 0) continue;
    const r = e[rKey];
    const ratio = v / r;
    let status = "good";
    let label = "On target";
    if (def.dir === "lower") {
      if (ratio > 1.5) { status = "bad"; label = `${Math.round((ratio - 1) * 100)}% over`; }
      else if (ratio > 1.1) { status = "warn"; label = `${Math.round((ratio - 1) * 100)}% over`; }
    } else {
      if (ratio < 0.7) { status = "bad"; label = "Below benchmark"; }
      else if (ratio < 1) { status = "warn"; label = "Slightly below"; }
    }
    rows.push({ metric: def.label, value: def.fmt(v, currency), target: `vs ${def.fmt(r, currency)}`, status, statusLabel: label });
  }
  return rows;
};

const takeawayForFinding = (finding, currency) => {
  if (isDiagnostic(finding)) {
    return "What this means for you: this is a high-leverage optimization — fixing the driver moves cost-per-result toward your target without spending more.";
  }
  const amount = moneyMagnitude(finding.estimatedImpact || finding.evidence);
  if (amount > 0) {
    if (finding.evidence?.blocksDelivery === true) {
      return `What this means for you: fixing this restores ${formatMoney(amount, currency)} of proven delivery that is currently blocked.`;
    }
    return `What this means for you: fixing this can recover ${formatMoney(amount, currency)} in the next comparable period.`;
  }
  return "What this means for you: fixing this removes account drag before it turns into measurable waste.";
};

// The evidence-grounded "why" for a finding. Prefers the rule's own diagnosis
// (finding.rootCause); falls back to an honest, non-generic line derived from
// the finding's own evidence rather than a fixed placeholder.
const whyText = (finding) => {
  if (finding.rootCause && String(finding.rootCause).trim()) {
    return String(finding.rootCause).trim();
  }
  const reason = finding.evidence?.reason;
  if (reason === "zero_conversions") {
    return "This segment is taking real spend and clicks but returning no conversions, while the rest of the account converts at baseline — spend is being allocated here without the performance to justify it.";
  }
  if (reason === "worse_than_baseline") {
    return "This segment converts at a worse rate than the account baseline, so each result here costs more than it does elsewhere; the blended average hides the gap.";
  }
  // No rule-level diagnosis available: be explicit about that rather than
  // implying a cause the data doesn't support.
  return "The evidence below isolates the pattern in the account data. Confirm the specific driver — targeting, creative, bidding, or tracking — against these figures before changing budgets.";
};

const findingBlock = (finding, currency = "USD") => {
  const impact = finding.estimatedImpact || "Business risk identified; the available data does not support a reliable money estimate.";
  const proseContext = `${finding.detail || finding.title} ${impact}`;
  const bodyBlocks = [
    {
      type: "paragraph",
      text: `**What is happening:** ${finding.detail || finding.title}`,
    },
    {
      type: "paragraph",
      text: `**Why it is happening:** ${whyText(finding)}`,
    },
    {
      type: "paragraph",
      text: `**Estimated business impact:** ${impact}`,
    },
  ];
  const chart = chartForFinding(finding, currency);
  if (chart) {
    // Thread the account currency onto the chart block so the renderer formats
    // any value-only money rows in the right currency (not the USD default).
    if (chart.currency == null) chart.currency = currency;
    bodyBlocks.push(chart);
  }
  // Proof table: where the finding carries a value↔benchmark pair, show the
  // claim as Metric | Value | Benchmark | Status (the "show your proof" format).
  // Add a few context rows (recoverable, confidence) so it reads as a scorecard.
  const proofRows = findingProofRows(finding, currency);
  if (proofRows.length) {
    const amount = moneyMagnitude(finding.estimatedImpact || finding.evidence);
    const extras = [];
    if (amount > 0 && !isDiagnostic(finding)) extras.push({ metric: "Recoverable spend", value: formatMoney(amount, currency), target: "—", status: "neutral" });
    const conf = finding.evidence?.confidence;
    if (conf) extras.push({ metric: "Confidence", value: cleanReportText(String(conf)), target: "—", status: "neutral" });
    bodyBlocks.push({ type: "scorecard", rows: [...proofRows, ...extras].slice(0, 6), currency });
  } else {
    const rows = evidenceRows(finding, currency, proseContext);
    if (rows.length) bodyBlocks.push({ type: "evidence_table", rows, proseContext, currency });
  }
  bodyBlocks.push({
    type: "paragraph",
    text: "**Expected outcome after fixing:** spend should shift away from the flagged weakness and performance should move closer to the account baseline.",
  });
  bodyBlocks.push({ type: "takeaway", text: takeawayForFinding(finding, currency) });

  return {
    type: "finding",
    id: null,
    severity: finding.severity,
    headline: finding.title,
    confidence: findingConfidence(finding),
    ease: findingEase(finding),
    body_blocks: bodyBlocks,
    fix_steps: Array.isArray(finding.fixSteps) && finding.fixSteps.length
      ? finding.fixSteps.slice(0, 5)
      : ["Review this issue in the ad platform and apply the recommended change.", "Re-run the audit after the next full reporting cycle."],
  };
};

// ── Account scorecard ─────────────────────────────────────────────────────────

/**
 * The headline-metrics scorecard: every account metric measured against its
 * industry benchmark or the client's declared target, with a pass/watch/fail
 * verdict. This is the "show your proof" element — it anchors every later claim
 * to a number the client can check, the way a strategist opens a review. Returns
 * null when there isn't enough spend to judge.
 */
const accountScorecardSection = (audit, currency, totals) => {
  const spend = num(totals.spend);
  if (spend <= 0) return null;
  const impressions = num(totals.impressions);
  const clicks = num(totals.clicks);
  const conversions = num(totals.conversions);

  const sectionA = audit.businessProfileSnapshot?.sectionA || {};
  const businessType = sectionA.businessType || "Other";
  const platform = audit.selectedPlatforms?.[0] || "GOOGLE";
  const targetCpa = num(sectionA.targetCpa);

  const ctr = impressions > 0 ? (clicks / impressions) * 100 : null;
  const cpc = clicks > 0 ? spend / clicks : null;
  const cpa = conversions > 0 ? spend / conversions : null;

  const rows = [
    { metric: "Total spend", value: formatMoney(spend, currency), target: "—", status: "neutral" },
    { metric: "Conversions", value: Math.round(conversions).toLocaleString("en-US"), target: "—", status: "neutral" },
  ];

  // CTR vs industry benchmark (higher is better).
  const ctrBench = getBenchmark("ctr", platform, businessType);
  if (ctr != null && ctrBench) {
    let status = "bad";
    let label = "Below benchmark";
    if (ctr >= ctrBench.good) { status = "good"; label = "Strong"; }
    else if (ctr >= ctrBench.warning) { status = "warn"; label = "Acceptable"; }
    rows.push({ metric: "Click-through rate", value: `${ctr.toFixed(2)}%`, target: `≥ ${ctrBench.warning}%`, status, statusLabel: label });
  } else if (ctr != null) {
    rows.push({ metric: "Click-through rate", value: `${ctr.toFixed(2)}%`, target: "—", status: "neutral" });
  }

  if (cpc != null) {
    // CPC is often < 1 unit of currency — round to 2dp so it doesn't collapse to
    // a bare "PKR 3" like the integer money formatter would.
    const cpcStr = `${String(currency || "USD").toUpperCase()} ${cpc.toFixed(2)}`;
    rows.push({ metric: "Avg cost per click", value: cpcStr, target: "—", status: "neutral" });
  }

  // CPA vs declared target (lower is better).
  if (cpa != null) {
    if (targetCpa > 0) {
      const ratio = cpa / targetCpa;
      let status = "good";
      let label = "On target";
      if (ratio > 1.5) { status = "bad"; label = `${Math.round((ratio - 1) * 100)}% over target`; }
      else if (ratio > 1.1) { status = "warn"; label = `${Math.round((ratio - 1) * 100)}% over target`; }
      rows.push({ metric: "Cost per acquisition", value: formatMoney(cpa, currency), target: formatMoney(targetCpa, currency), status, statusLabel: label });
    } else {
      rows.push({ metric: "Cost per acquisition", value: formatMoney(cpa, currency), target: "—", status: "neutral" });
    }
  }

  const caption =
    targetCpa > 0
      ? `CPA target (${formatMoney(targetCpa, currency)}) from your intake; CTR benchmark for ${businessType} on ${platformLabels[platform] || platform}.`
      : `CTR benchmark for ${businessType} on ${platformLabels[platform] || platform}. Set a target CPA in intake to score CPA against it.`;

  return {
    id: "scorecard",
    eyebrow: "Account scorecard",
    title: "The headline metrics, against target",
    intro:
      "Each account metric measured against its industry benchmark or your declared target, with a clear verdict — so every claim in this audit is anchored to a number you can check.",
    blocks: [{ type: "scorecard", rows, caption }],
  };
};

// ── Per-campaign deep-dive ────────────────────────────────────────────────────

const campaignDispersionMaterial = 1000; // spend that makes a zero-conv verdict confident

/**
 * An at-a-glance status pill for a campaign (the ✅/⚠️/🔴 verdict column that
 * makes the deep-dive read like a strategist's scorecard). Mirrors the prose
 * verdict's logic but as a single tone + short label.
 */
const campaignStatus = (c, baselineCpa) => {
  const status = String(c.status || "").toUpperCase();
  const results = num(c.results ?? c.conversions);
  const spend = num(c.spend);
  const cpa = c.cpa != null ? num(c.cpa) : results > 0 ? spend / results : null;
  if (/DISAPPROVED/.test(status)) return { status: "bad", text: "Blocked" };
  if (results === 0 && spend >= campaignDispersionMaterial) return { status: "bad", text: "Zero conv" };
  if (baselineCpa && cpa && cpa >= baselineCpa * 2.5) return { status: "bad", text: `${(cpa / baselineCpa).toFixed(1)}x baseline` };
  if (baselineCpa && cpa && cpa >= baselineCpa * 1.5) return { status: "warn", text: "Above avg" };
  if (baselineCpa && cpa && cpa <= baselineCpa) return { status: "good", text: "At/below avg" };
  if (results > 0) return { status: "warn", text: "Above avg" };
  if (/PAUSED|ARCHIVED/.test(status)) return { status: "neutral", text: "Paused" };
  return { status: "neutral", text: "Monitor" };
};

/**
 * One-line, consultant-style verdict for a campaign, judged against the account
 * baseline CPA. Deterministic — the engine assigns the verdict, the report just
 * renders it.
 */
const campaignVerdict = (c, baselineCpa) => {
  const status = String(c.status || "").toUpperCase();
  const results = num(c.results ?? c.conversions);
  const spend = num(c.spend);
  const cpa = c.cpa != null ? num(c.cpa) : results > 0 ? spend / results : null;

  if (/DISAPPROVED/.test(status)) {
    return "Disapproved — blocked from delivering; restoring it is the priority.";
  }
  if (results === 0 && spend >= campaignDispersionMaterial) {
    return "Material spend, zero conversions — likely a targeting or geo misconfiguration.";
  }
  if (baselineCpa && cpa && cpa >= baselineCpa * 2.5) {
    return `Converting at ${(cpa / baselineCpa).toFixed(1)}× the account average — the main efficiency drag.`;
  }
  if (baselineCpa && cpa && cpa <= baselineCpa) {
    return "At or below the account's average cost — protect and scale this one.";
  }
  if (results > 0) {
    return "Converting, but above the account average — room to tighten.";
  }
  if (/PAUSED|ARCHIVED/.test(status)) {
    return "Paused with little data — low priority until reactivated.";
  }
  return "Limited data — monitor before acting.";
};

/**
 * The per-campaign performance section — the spine of a consultant-grade audit.
 * A flat findings list tells the client WHAT is wrong; this shows them every
 * campaign's numbers and a verdict, which is what reads as expert review.
 * Returns null when there isn't a meaningful multi-campaign breakdown.
 */
const campaignDeepDiveSection = (audit, currency, totals) => {
  const platforms = audit.normalizedDataset?.data?.platforms || {};
  const rows = [];
  for (const platform of Object.values(platforms)) {
    for (const c of platform?.byLevel?.campaign || []) {
      if (num(c.spend) > 0) rows.push(c);
    }
  }
  if (rows.length < 2) return null;

  const baselineCpa =
    num(totals.conversions) > 0 ? num(totals.spend) / num(totals.conversions) : null;

  const ranked = rows.sort((a, b) => num(b.spend) - num(a.spend)).slice(0, 8);

  const tableRows = ranked.map((c) => {
    const results = num(c.results ?? c.conversions);
    const cpa = c.cpa != null ? num(c.cpa) : results > 0 ? num(c.spend) / results : null;
    return [
      c.name || "(unnamed campaign)",
      num(c.spend),
      String(Math.round(results)),
      cpa != null ? formatMoney(cpa, currency) : "—",
      campaignStatus(c, baselineCpa), // status pill cell { status, text }
      campaignVerdict(c, baselineCpa),
    ];
  });

  return {
    id: "campaign-deep-dive",
    eyebrow: "Campaign performance",
    title: "Every campaign, with a verdict",
    intro:
      "Each campaign's own numbers against the account baseline" +
      (baselineCpa ? ` (cost per result ${formatMoney(baselineCpa, currency)})` : "") +
      " — so the diagnosis is grounded in per-campaign performance, not a blended average.",
    blocks: [
      {
        type: "data_table",
        columns: [
          { header: "Campaign", align: "left" },
          { header: "Spend", align: "right", width: "100px" },
          { header: "Results", align: "right", width: "70px" },
          { header: "Cost / result", align: "right", width: "110px" },
          { header: "Status", align: "left", width: "108px" },
          { header: "Verdict", align: "left" },
        ],
        currency,
        rows: tableRows,
        footnote:
          "Cost per result uses each campaign's own conversions; the verdict compares it to the account baseline.",
      },
    ],
  };
};

/**
 * Grounded next-move bullets for a campaign card, derived from its status verdict
 * (we don't invent creative/audience specifics we can't see — these are honest
 * directional moves the data supports).
 */
const campaignNextSteps = (c, baselineCpa) => {
  const st = campaignStatus(c, baselineCpa).status;
  if (st === "good") {
    return [
      "Protect this campaign — it is carrying the account's efficiency.",
      "Scale budget in small increments (~20%) while cost per result holds.",
      "Add a backup ad group or audience layer to de-risk creative/audience fatigue.",
    ];
  }
  if (st === "bad") {
    return [
      "Treat as the priority — diagnose targeting, audience, and bidding before any budget change.",
      "Do not apply an account-wide cut; that would starve the healthy campaigns.",
      "Re-check after a full reporting cycle once the fix is in.",
    ];
  }
  return [
    "Above the account average — tighten targeting or add/lower a cost-per-result cap.",
    "Compare its audience and placement mix against the best-performing campaign.",
    "Re-evaluate next cycle and reallocate toward what converts.",
  ];
};

/**
 * Per-campaign deep-dive CARDS — each top campaign scored against benchmark and
 * target (CTR vs industry, CPA vs target/baseline), with a verdict and its next
 * moves. Matches the reference Claude audit's per-campaign sections. Sits after
 * the overview table. Returns null without a meaningful multi-campaign breakdown.
 */
const campaignCardsSection = (audit, currency, totals) => {
  const platforms = audit.normalizedDataset?.data?.platforms || {};
  const all = [];
  for (const platform of Object.values(platforms)) {
    for (const c of platform?.byLevel?.campaign || []) {
      if (num(c.spend) > 0) all.push(c);
    }
  }
  if (all.length < 2) return null;

  const baselineCpa = num(totals.conversions) > 0 ? num(totals.spend) / num(totals.conversions) : null;
  const sectionA = audit.businessProfileSnapshot?.sectionA || {};
  const businessType = sectionA.businessType || "Other";
  const platform = audit.selectedPlatforms?.[0] || "GOOGLE";
  const targetCpa = num(sectionA.targetCpa);
  const ctrBench = getBenchmark("ctr", platform, businessType);

  const top = all.sort((a, b) => num(b.spend) - num(a.spend)).slice(0, 3);

  const cards = top.map((c) => {
    const spend = num(c.spend);
    const results = num(c.results ?? c.conversions);
    const impressions = num(c.impressions);
    const clicks = num(c.clicks);
    const cpa = c.cpa != null ? num(c.cpa) : results > 0 ? spend / results : null;
    const ctr = impressions > 0 ? (clicks / impressions) * 100 : null;

    const metrics = [
      { metric: "Spend", value: formatMoney(spend, currency), target: "—", status: "neutral" },
      { metric: "Conversions", value: Math.round(results).toLocaleString("en-US"), target: "—", status: "neutral" },
    ];

    if (ctr != null && ctrBench) {
      let status = "bad";
      let label = "Below benchmark";
      if (ctr >= ctrBench.good) { status = "good"; label = "Strong"; }
      else if (ctr >= ctrBench.warning) { status = "warn"; label = "Acceptable"; }
      metrics.push({ metric: "Click-through rate", value: `${ctr.toFixed(2)}%`, target: `≥ ${ctrBench.warning}%`, status, statusLabel: label });
    }

    if (cpa != null) {
      const ref = targetCpa > 0 ? targetCpa : baselineCpa;
      if (ref && ref > 0) {
        const ratio = cpa / ref;
        let status = "good";
        let label = "On target";
        if (ratio > 1.5) { status = "bad"; label = `${Math.round((ratio - 1) * 100)}% over`; }
        else if (ratio > 1.1) { status = "warn"; label = `${Math.round((ratio - 1) * 100)}% over`; }
        metrics.push({ metric: "Cost per result", value: formatMoney(cpa, currency), target: `vs ${formatMoney(ref, currency)}`, status, statusLabel: label });
      } else {
        metrics.push({ metric: "Cost per result", value: formatMoney(cpa, currency), target: "—", status: "neutral" });
      }
    }

    const st = campaignStatus(c, baselineCpa);
    return {
      type: "campaign_card",
      name: c.name || "(unnamed campaign)",
      status: st.status,
      status_label: st.text,
      spend: formatMoney(spend, currency),
      metrics,
      verdict: campaignVerdict(c, baselineCpa),
      steps: campaignNextSteps(c, baselineCpa),
    };
  });

  return {
    id: "campaign-cards",
    eyebrow: "Campaign deep-dive",
    title: "Top campaigns, scored",
    intro:
      "Each top-spending campaign measured against its CTR benchmark and CPA target, with a verdict and its next move — the per-campaign view a strategist works from.",
    blocks: cards,
  };
};

// ── Root-cause correlation ────────────────────────────────────────────────────

/**
 * Synthesize the account's binding constraints into one "real story" line that
 * leads the executive summary — connecting symptoms to their cause the way a
 * strategist opens a review ("the account is dormant because of a compliance
 * block and a geography error, not a strategic pause"), instead of just
 * restating the top finding. Returns null when no root-cause finding is present.
 */
const rootCauseSynthesis = (findings = []) => {
  const blockers = findings.filter((f) => f.evidence?.blocksDelivery === true);
  const geo = findings.filter((f) => /-GEO-001$/.test(f.ruleId || ""));
  const parts = [];

  if (blockers.length) {
    const lead = blockers[0];
    const share = num(lead.evidence?.resultSharePercent);
    const shareClause = share > 0 ? ` — the lead one drove ${Math.round(share)}% of all results` : "";
    parts.push(
      `${blockers.length === 1 ? "A proven ad is" : `${blockers.length} proven ads are`} blocked by Meta policy review${shareClause}. The account is constrained by approval status, not media buying: restoring delivery is the highest-leverage move, and no budget or bid change can outperform it.`
    );
  }

  if (geo.length) {
    const country = geo[0].evidence?.country;
    parts.push(
      `Spend is also leaking to ${country || "a foreign market"} the budget cannot compete in — the root cause behind the zero-conversion campaigns. The fix is correcting the location targeting, not pausing the campaigns.`
    );
  }

  if (!parts.length) return null;
  return `**The real story:** ${parts.join(" ")}`;
};

/**
 * The phased roadmap — sequences the findings into Phase 1 (stop active waste /
 * delivery blocks), Phase 2 (tighten high-impact inefficiency), Phase 3
 * (structural + hygiene). The strategic "how to get there over time" the client
 * asked for, distinct from the week-one action checklist.
 */
const roadmapSection = (findings, currency) => {
  if (!findings.length) return null;

  const used = new Set();
  const take = (predicate) => {
    const picked = findings.filter((f) => !used.has(f) && predicate(f));
    picked.forEach((f) => used.add(f));
    return picked;
  };

  const phase1 = take((f) => f.severity === "CRITICAL" || f.evidence?.blocksDelivery === true);
  const phase2 = take((f) => f.severity === "HIGH" || (f.severity === "MEDIUM" && moneyMagnitude(f.estimatedImpact) > 0));
  const phase3 = take(() => true); // everything else: structural / hygiene / low

  const mkItems = (arr) =>
    arr.slice(0, 5).map((f) => ({
      action: `**${f.title}:** ${(Array.isArray(f.fixSteps) && f.fixSteps[0]) || "Apply the recommended fix in the platform."}`,
      effort: findingEase(f) === "easy" ? "~1 hour" : findingEase(f) === "medium" ? "Half day" : "Technical",
      result: impactLabel(f, currency),
    }));

  // Only non-empty phases render; number them sequentially so the reader never
  // sees a "Phase 1 → Phase 3" gap when a tier has no finding.
  const candidates = [
    { when: phase1, timeframe: "This week", goal: "**Stop the bleeding** — fix what is actively wasting spend or blocking delivery right now." },
    { when: phase2, timeframe: "Weeks 2–4", goal: "**Tighten efficiency** — pull the high-impact inefficiencies back toward target." },
    { when: phase3, timeframe: "Ongoing", goal: "**Structure & scale** — clear hygiene risks and build durable account structure." },
  ];
  const phases = candidates
    .filter((p) => p.when.length)
    .map((p, i) => ({ label: `Phase ${i + 1}`, timeframe: p.timeframe, goal: p.goal, items: mkItems(p.when) }));
  if (!phases.length) return null;

  return {
    id: "roadmap",
    eyebrow: "Roadmap & action plan",
    title: "The phased plan — what to do, in order",
    intro:
      "This is your action plan, sequenced by leverage: start at Phase 1 this week (stop active waste), then tighten efficiency, then build durable structure. Each item shows the move, the effort, and what it recovers.",
    blocks: [{ type: "roadmap", phases }],
  };
};

const formatTrendDate = (value) => {
  if (!value) return "your previous audit";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "your previous audit";
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(d);
};

/**
 * "Since your last audit" — the continuity layer that turns a one-off PDF into a
 * subscription a Claude chat can't replace. Compares this audit to the previous
 * completed one for the same account: metric deltas (health, recoverable, CPA,
 * CTR, conversions) with a better/worse verdict, plus which findings were
 * resolved, which are new, and which persist. Returns null on a first audit
 * (no `previous`).
 */
const trendSection = ({ findings, totals, recoverable, healthScore, currency, previous }) => {
  if (!previous) return null;
  const prevTotals = previous.totals || {};
  const prevFindings = Array.isArray(previous.findings) ? previous.findings : [];

  const rows = [];
  const signed = (n) => (n > 0 ? `+${n}` : `${n}`);

  if (typeof healthScore === "number" && typeof previous.healthScore === "number") {
    const d = healthScore - previous.healthScore;
    rows.push({ metric: "Health score", previous: String(previous.healthScore), current: String(healthScore), change: `${signed(d)} pts`, tone: d > 0 ? "good" : d < 0 ? "bad" : "neutral" });
  }

  // Recoverable identified — lower is better (you closed leaks).
  const prevRecoverable = reconcileRecoverable(
    prevFindings.filter((f) => f.evidence?.blocksDelivery !== true && f.evidence?.diagnostic !== true),
    { accountSpend: num(prevTotals.spend) }
  ).total;
  if (prevRecoverable > 0 || recoverable > 0) {
    const d = recoverable - prevRecoverable;
    const changeStr = `${d < 0 ? "-" : "+"}${formatMoney(Math.abs(d), currency)}`;
    rows.push({ metric: "Recoverable identified", previous: formatMoney(prevRecoverable, currency), current: formatMoney(recoverable, currency), change: changeStr, tone: d < 0 ? "good" : d > 0 ? "bad" : "neutral" });
  }

  // CPA — lower is better.
  const cpaNow = num(totals.conversions) > 0 ? num(totals.spend) / num(totals.conversions) : null;
  const cpaPrev = num(prevTotals.conversions) > 0 ? num(prevTotals.spend) / num(prevTotals.conversions) : null;
  if (cpaNow != null && cpaPrev != null) {
    const pct = cpaPrev > 0 ? Math.round((cpaNow / cpaPrev - 1) * 100) : null;
    rows.push({ metric: "Cost per acquisition", previous: formatMoney(cpaPrev, currency), current: formatMoney(cpaNow, currency), change: pct != null ? `${pct > 0 ? "+" : ""}${pct}%` : "—", tone: cpaNow < cpaPrev ? "good" : cpaNow > cpaPrev ? "bad" : "neutral" });
  }

  // CTR — higher is better.
  const ctrNow = num(totals.impressions) > 0 ? (num(totals.clicks) / num(totals.impressions)) * 100 : null;
  const ctrPrev = num(prevTotals.impressions) > 0 ? (num(prevTotals.clicks) / num(prevTotals.impressions)) * 100 : null;
  if (ctrNow != null && ctrPrev != null) {
    const d = ctrNow - ctrPrev;
    rows.push({ metric: "Click-through rate", previous: `${ctrPrev.toFixed(2)}%`, current: `${ctrNow.toFixed(2)}%`, change: `${d >= 0 ? "+" : ""}${d.toFixed(2)}pp`, tone: d > 0 ? "good" : d < 0 ? "bad" : "neutral" });
  }

  // Conversions — higher is better.
  if (prevTotals.conversions != null) {
    const c = Math.round(num(totals.conversions));
    const p = Math.round(num(prevTotals.conversions));
    const d = c - p;
    rows.push({ metric: "Conversions", previous: p.toLocaleString("en-US"), current: c.toLocaleString("en-US"), change: signed(d), tone: d > 0 ? "good" : d < 0 ? "bad" : "neutral" });
  }

  // Findings diff by ruleId.
  const currIds = new Set(findings.map((f) => f.ruleId));
  const prevIds = new Set(prevFindings.map((f) => f.ruleId));
  const resolved = prevFindings.filter((f) => f.ruleId && !currIds.has(f.ruleId));
  const added = findings.filter((f) => f.ruleId && !prevIds.has(f.ruleId));
  const persisting = findings.filter((f) => f.ruleId && prevIds.has(f.ruleId)).length;

  const since = formatTrendDate(previous.completedAt);
  const blocks = [
    {
      type: "paragraph",
      text: `Since your last audit on ${since}: **${resolved.length}** ${resolved.length === 1 ? "issue" : "issues"} resolved, **${added.length}** new, **${persisting}** still open.`,
    },
  ];
  if (rows.length) blocks.push({ type: "trend", rows, caption: `Each metric versus your ${since} audit. Green moved in the right direction.` });
  if (resolved.length) {
    blocks.push({ type: "callout", tone: "good", text: `**Resolved since last audit:** ${resolved.slice(0, 6).map((f) => f.title).filter(Boolean).join("; ")}.` });
  }
  if (added.length) {
    blocks.push({ type: "callout", tone: "warn", text: `**New since last audit:** ${added.slice(0, 6).map((f) => f.title).filter(Boolean).join("; ")}.` });
  }

  return {
    id: "trend",
    eyebrow: "Since your last audit",
    title: "What changed",
    intro: "Your account measured against your previous audit — what you fixed, what regressed, and what is still open. This is the accountability a one-off audit can't give you.",
    blocks,
  };
};

const noFindingsDocument = ({ audit, currency, totals }) => ({
  masthead: {
    headline: "No measurable money leaks detected",
    subline: "The available data did not trigger any material performance findings.",
    platform: platformDocLabels[audit.selectedPlatforms?.[0]] || "google_ads",
    health_score: audit.healthScore ?? 100,
    score_band: scoreBand(audit.healthScore ?? 100),
    period: getPeriod(audit),
    currency,
    tracking_verified: true,
  },
  key_numbers: [
    { value: "0", label: "Material findings", tone: "good" },
    { value: formatMoney(totals.spend || 0, currency), label: "Spend reviewed", tone: "neutral" },
    { value: String(Math.round(num(totals.conversions))), label: "Conversions reviewed", tone: "neutral" },
  ],
  executive_summary: {
    verdict: "No measurable money leak was detected in the available audit data.",
    paragraphs: [
      "**The account is clean from the available evidence.** The audit did not find a measured waste pattern, tracking break, or structural risk large enough to flag.",
      "**Keep monitoring.** Re-run the audit after the next reporting cycle so historical deltas can confirm the account stays stable.",
    ],
  },
  sections: [],
  action_plan: {
    title: "What to do this week, in order",
    intro: "No urgent fixes were detected. Keep the account under monitoring.",
    rows: [{ order: 1, action: "**Re-run after the next full cycle** to build trend history.", effort: "~5 min", result: "Trend baseline", result_tone: "neutral", links_to_finding: null }],
  },
  method_notes: [
    { label: "Honesty", text: "No impact is shown unless it is supported by deterministic rule evidence." },
  ],
});

export const buildReportDocumentFromAudit = (audit) => {
  // A cached premiumReport is built during AI report generation with only the
  // dataset SUMMARY (no per-campaign records), so it lacks the campaign
  // deep-dive. When we have the full normalized dataset (the report view + PDF
  // paths always do), rebuild fresh so dataset-dependent sections render; only
  // fall back to the cache when we genuinely can't do better.
  const existing = audit.aiReport?.output?.premiumReport;
  const hasFullDataset = !!audit.normalizedDataset?.data?.platforms;
  if (existing && !hasFullDataset && typeof existing === "object" && validateReportDocument(existing).isValid) {
    return existing;
  }

  const currency = getCurrency(audit);
  const totals = getTotals(audit);
  const findings = sortFindingsForReport(audit.ruleFindings || []);
  if (!findings.length) return noFindingsDocument({ audit, currency, totals });

  const top = findings[0];
  const topMoney = moneyMagnitude(top.estimatedImpact || top.evidence);
  const score = audit.healthScore ?? 0;
  const severityCounts = findings.reduce((acc, f) => {
    acc[f.severity] = (acc[f.severity] || 0) + 1;
    return acc;
  }, {});
  const scoreRows = categoryScoreRows(audit);
  // "Recoverable" = waste you can CUT. A delivery block (a disapproved ad) is
  // restorable upside, not recovered waste — counting it conflates two different
  // things and overstates the headline — so it's excluded here and surfaces as
  // the lead finding instead. Its money still shows on its own finding card.
  const isRecoverableWaste = (f) =>
    f.evidence?.blocksDelivery !== true &&
    f.evidence?.diagnostic !== true &&
    findingRecoverable(f) > 0;
  const quantified = findings.filter(isRecoverableWaste);
  // Overlap-aware total: the same wasted spend surfaces as several findings
  // (campaign + audience + device + geo on one campaign). Count each dollar once
  // instead of summing — naive summing inflates the headline 2-3×.
  const { total: recoverable } = reconcileRecoverable(
    findings.filter((f) => f.evidence?.blocksDelivery !== true && f.evidence?.diagnostic !== true),
    { accountSpend: num(totals.spend) }
  );
  const platform = audit.selectedPlatforms?.[0] || top.platform || "GOOGLE";
  const platformLabel = platformLabels[platform] || "Paid Media";

  const sections = [];

  // "Since your last audit" leads when a prior audit exists — the continuity
  // hook. Attached by the caller (PDF pipeline / HTML view) as audit.previousAudit.
  const trend = trendSection({
    findings,
    totals,
    recoverable,
    healthScore: score,
    currency,
    previous: audit.previousAudit,
  });
  if (trend) sections.push(trend);

  sections.push({
    id: "scores",
    eyebrow: "Health score",
    title: `Where the ${score} comes from`,
    intro:
      scoreRows.length >= 3
        ? "The score breakdown shows which account areas are healthy and which areas generated findings."
        : "The audit has an overall health score, but no reliable component-level breakdown for this run.",
    blocks:
      scoreRows.length >= 3
        ? [{ type: "bar_chart_h", kind: "score", score, score_band: scoreBand(score), rows: scoreRows, gridlines: true, caption: "Scores below 85 are treated as pressure points." }]
        : [{ type: "score_gauge", score, score_band: scoreBand(score), caption: "Component-level breakdown not available for this audit." }],
  });

  // Account scorecard — headline metrics vs benchmark/target with a verdict.
  // The "show your proof" section the client asked for.
  const scorecard = accountScorecardSection(audit, currency, totals);
  if (scorecard) sections.push(scorecard);

  if (quantified.length > 0) {
    const maxImpact = Math.max(
      ...quantified.map((f) => findingRecoverable(f)),
      1
    );
    sections.push({
      id: "money-map",
      eyebrow: "Money map",
      title: "Where the recoverable spend is concentrated",
      intro: "Only findings with measured financial evidence appear here. Structural risks stay out of this chart unless the engine can quantify them.",
      blocks: [
        {
          type: "bar_chart_h",
          rows: quantified.slice(0, 6).map((f) => {
            const value = findingRecoverable(f);
            return {
              label: f.title,
              value,
              max: maxImpact,
              tone: f === top ? "warn" : "brand",
              display: formatMoney(value, currency),
            };
          }),
          currency,
          gridlines: true,
          caption: "Measured recoverable spend by finding.",
        },
      ],
    });
  }

  sections.push({
    id: "findings",
    eyebrow: "Findings",
    title: `${findings.length} findings, ranked by impact`,
    intro: "Findings are ordered by leverage — severity and root-cause gravity first, then confidence, then recoverable spend.",
    blocks: [
      {
        type: "data_table",
        columns: [
          { header: "#", align: "left", width: "44px" },
          { header: "Finding", align: "left" },
          { header: "Severity", align: "left", width: "92px" },
          { header: "Impact", align: "right", width: "140px" },
        ],
        currency,
        rows: findings.slice(0, 8).map((f, i) => [
          String(i + 1),
          f.title,
          f.severity,
          impactLabel(f, currency),
        ]),
        footnote: "Money impact is shown only when the account data supports a reliable estimate. Other rows are still important business risks.",
      },
    ],
  });

  // Per-campaign deep-dive — the consultant-grade spine. Sits between the
  // findings list and the detailed evidence so the reader sees every campaign's
  // numbers + verdict before the issue-by-issue breakdown.
  const deepDive = campaignDeepDiveSection(audit, currency, totals);
  if (deepDive) sections.push(deepDive);

  // Per-campaign scored cards (CTR vs benchmark, CPA vs target) — the strategist
  // view, after the overview table.
  const campaignCards = campaignCardsSection(audit, currency, totals);
  if (campaignCards) sections.push(campaignCards);

  sections.push({
    id: "finding-detail",
    eyebrow: "Evidence",
    title: "The evidence, finding by finding",
    intro: "Each finding shows what is happening, the business impact, supporting evidence, confidence, and the recommended fix.",
    blocks: findings.slice(0, 6).map((finding) => findingBlock(finding, currency)),
  });

  const benchmarkComparisons = audit.aiReport?.output?.benchmarkComparisons || [];
  const validBenchmarkComparisons = benchmarkComparisons.filter(
    (item) => item && typeof item === "object" && item.label && item.finding
  );
  if (validBenchmarkComparisons.length) {
    sections.push({
      id: "benchmarks",
      eyebrow: "Benchmarks",
      title: "How this account compares",
      intro: "Benchmark comparisons appear only when peer, historical, or industry facts are available for this audit.",
      blocks: validBenchmarkComparisons.slice(0, 6).map((item) => ({
        type: "callout",
        tone: item.confidence === "high" ? "good" : "info",
        text: `**${item.label}:** ${item.finding}`,
      })),
    });
  }

  // Phased strategic roadmap — sits after the evidence/benchmarks, before the
  // week-one action checklist renders.
  const roadmap = roadmapSection(findings, currency);
  if (roadmap) sections.push(roadmap);

  const projection = topMoney > 0
    ? {
        period_value: topMoney,
        quarterly: topMoney * 3,
        annualized: topMoney * 12,
        disclaimer: "Projection multiplies the measured period impact and assumes spend and performance patterns remain stable.",
      }
    : undefined;

  return {
    masthead: {
      headline: topMoney > 0 ? `${top.title}`.slice(0, 80) : `${platformLabel} needs cleanup`,
      subline: topMoney > 0
        ? `${top.estimatedImpact} is the clearest quantified opportunity in this audit.`
        : "The largest risks are structural and not safely quantifiable from available data.",
      platform: platformDocLabels[platform] || "google_ads",
      health_score: score,
      score_band: scoreBand(score),
      period: getPeriod(audit),
      currency,
      tracking_verified: !findings.some((f) => /tracking|pixel|capi/i.test(`${f.title} ${f.detail}`)),
    },
    key_numbers: [
      { value: recoverable > 0 ? formatMoney(recoverable, currency) : "No quantified leak", label: recoverable > 0 ? "Recoverable this period" : "Measured money leaks", tone: recoverable > 0 ? "good" : "good" },
      { value: formatMoney(totals.spend || 0, currency), label: "Spend reviewed", tone: "neutral" },
      { value: String(Math.round(num(totals.conversions))), label: "Conversions reviewed", tone: "neutral" },
      { value: String(findings.length), label: `${severityCounts.CRITICAL || 0} critical · ${severityCounts.HIGH || 0} high`, tone: severityCounts.CRITICAL || severityCounts.HIGH ? "warn" : "neutral" },
    ],
    executive_summary: {
      verdict: topMoney > 0
        ? `${top.estimatedImpact} is the single most important number in this audit.`
        : `The biggest issue is ${top.title}. It is a business risk, but the available data does not support a reliable money estimate.`,
      paragraphs: [
        // Root-cause synthesis leads when the account has a binding constraint
        // (a policy block or a geo misconfiguration), framing the real story
        // before the lead-issue restatement.
        ...(rootCauseSynthesis(findings) ? [rootCauseSynthesis(findings)] : []),
        `**Lead issue:** ${top.title}. ${top.detail || top.estimatedImpact || "This is the highest-priority finding in the account data."}`,
        `**Why it matters:** Findings are ranked by leverage — the most damaging issue leads (severity and root-cause gravity first, then confidence and recoverable spend), not simply the biggest dollar figure.`,
        "**Next move:** Start with the first issue in this report, then re-run the audit after the next full reporting cycle to measure the delta.",
      ],
      ...(projection ? { projection } : {}),
    },
    sections,
    action_plan: {
      title: "What to do this week, in order",
      intro: "This sequence prioritizes business impact first, then confidence and ease of implementation.",
      rows: findings.slice(0, 5).map((f, index) => ({
        order: index + 1,
        action: `**${f.title}:** ${(Array.isArray(f.fixSteps) && f.fixSteps[0]) || "Apply the recommended fix in the platform."}`,
        effort: findingEase(f) === "easy" ? "~1 hour" : findingEase(f) === "medium" ? "Half day" : "Technical",
        result: impactLabel(f, currency),
        result_tone: moneyMagnitude(f.estimatedImpact) > 0 ? "good" : "neutral",
        links_to_finding: f.ruleId,
      })),
    },
    method_notes: [
      { label: "Numbers", text: "Every figure comes from verified account data. The report does not invent chart values." },
      { label: "Benchmarks", text: validBenchmarkComparisons.length ? "Peer, historical, or industry comparisons are shown only where available." : "No benchmark section is rendered because no benchmark facts were available." },
      { label: "Confidence", text: "Confidence labels reflect data coverage, severity, and sample notes." },
    ],
  };
};

const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);

export const validateReportDocument = (doc) => {
  const errors = [];
  if (!isObj(doc)) errors.push("ReportDocument must be an object.");
  if (!isObj(doc?.masthead)) errors.push("masthead is required.");
  if (!Array.isArray(doc?.key_numbers) || doc.key_numbers.length < 3 || doc.key_numbers.length > 4) {
    errors.push("key_numbers must contain 3-4 cells.");
  }
  if (!isObj(doc?.executive_summary)) errors.push("executive_summary is required.");
  if (!Array.isArray(doc?.sections)) errors.push("sections must be an array.");
  if (!isObj(doc?.action_plan)) errors.push("action_plan is required.");
  if (!Array.isArray(doc?.method_notes)) errors.push("method_notes must be an array.");
  return { isValid: errors.length === 0, errors };
};

export const __test__ = {
  moneyMagnitude,
  escapePlain,
};
