import { byLeverageDesc } from "../../lib/findings/priority.js";
import { reconcileRecoverable } from "../../lib/findings/recoverable.js";
import { parseMoney } from "../../lib/money.js";
import {
  detectConversionAnomalies,
  normName,
} from "../../lib/findings/conversionAnomaly.js";
import {
  buildCohortBaselines,
  cohortBaselineFor,
} from "../../lib/segments/cohortBaseline.js";
import { getBenchmark, resolveBusinessType, resolveGoogleNetwork } from "./auditEngine.service.js";

/**
 * Account baseline + tracking-anomaly set, computed independently of the engine
 * so the report is correct even when rendered from persisted data. When a
 * campaign reports conversions too cheap to be genuine (e.g. WhatsApp button taps
 * counted as leads), its fake conversions are excluded so the baseline reflects
 * the real account, and its name is returned so per-campaign verdicts flag it for
 * verification instead of recommending it be scaled.
 *
 * @returns {{ baselineCpa: number|null, anomalyNames: Set<string> }}
 */
const accountBaseline = (audit, totals) => {
  const platforms = audit.normalizedDataset?.data?.platforms || {};
  const campaigns = [];
  for (const platform of Object.values(platforms)) {
    for (const c of platform?.byLevel?.campaign || []) {
      if (num(c.spend) > 0) {
        campaigns.push({ name: c.name, spend: num(c.spend), conversions: num(c.results ?? c.conversions) });
      }
    }
  }
  const result = detectConversionAnomalies(campaigns);
  const blended =
    num(totals.conversions) > 0 ? num(totals.spend) / num(totals.conversions) : null;
  if (!result) return { baselineCpa: blended, anomalyNames: new Set() };
  return {
    baselineCpa: result.trustedBaselineCpa,
    anomalyNames: new Set(result.anomalies.map((a) => a.normName)),
  };
};

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

// ── Money-coherence display layer ─────────────────────────────────────────────
// A finding's prose is authored by the engine BEFORE overlap/cap reconciliation,
// so its money figure can be the GROSS measured amount (PKR 14,440) while the
// trust layer later assigns a smaller reconciled net (PKR 12,111). Quoting the
// stale gross on the cover next to the reconciled net in the table is the "two
// unlabeled numbers that answer the same question" bug. By engine convention the
// FIRST currency token in `estimatedImpact` IS the finding's recoverable amount,
// so it is safe to swap exactly that token — and only when the token matches the
// finding's own gross figure, so a CPA/target/spend that happens to lead a title
// is never touched.
const moneyTokenRegex = (currency) =>
  new RegExp(`(?:${String(currency || "USD").toUpperCase()}|\\$|€|£)\\s?\\d[\\d,]*(?:\\.\\d+)?`);

const netAdjustedText = (text, finding, currency = "USD") => {
  const original = String(text ?? "");
  if (!original) return original;
  const net = finding?.evidence?.netRecoverable;
  if (!Number.isFinite(net) || net <= 0) return original;
  if (
    isDiagnostic(finding) ||
    finding?.evidence?.advisory === true ||
    finding?.evidence?.blocksDelivery === true
  ) {
    return original;
  }
  const gross = moneyMagnitude(finding?.estimatedImpact);
  if (!(gross > 0) || Math.abs(gross - net) / net <= 0.02) return original;
  const re = moneyTokenRegex(currency);
  const match = original.match(re);
  if (!match) return original;
  const tokenValue = parseMoney(match[0]);
  if (!(tokenValue > 0) || Math.abs(tokenValue - gross) / gross > 0.02) return original;
  return original.replace(re, formatMoney(net, currency));
};

// Campaign names like "Display | PK | Signals | Tightened | 6/8" buried inside a
// dense sentence are unreadable — bold every known campaign name so it is
// instantly identifiable. Longest-first with token substitution so a name that is
// a substring of another name can't corrupt an already-wrapped match; quoted
// occurrences ("Name") collapse to the bold form without the quotes.
const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const emphasizeCampaignNames = (text, names) => {
  const original = String(text ?? "");
  if (!original || !names?.length) return original;
  let out = original;
  const sorted = [...new Set(names)]
    .filter((n) => typeof n === "string" && n.trim().length >= 4)
    .sort((a, b) => b.length - a.length);
  const tokens = [];
  sorted.forEach((name, i) => {
    const token = `\u0000N${i}\u0000`;
    const re = new RegExp(`"${escapeRegExp(name)}"|${escapeRegExp(name)}`, "g");
    if (re.test(out)) {
      out = out.replace(re, token);
      tokens.push([token, `**${name}**`]);
    }
  });
  for (const [token, bold] of tokens) out = out.split(token).join(bold);
  return out;
};

// Collect every campaign name in the dataset (spending + structure-only) for
// name emphasis in finding prose.
const collectCampaignNames = (audit) => {
  const names = new Set();
  const platforms = audit?.normalizedDataset?.data?.platforms || {};
  for (const platform of Object.values(platforms)) {
    for (const level of ["campaign", "campaignStructureOnly"]) {
      for (const c of platform?.byLevel?.[level] || []) {
        const name = typeof c?.name === "string" ? c.name.trim() : "";
        if (name.length >= 4) names.add(name);
      }
    }
  }
  return [...names];
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
  // Prefer a specific fact from the evidence over a vague bucket word — "102%
  // over its target" reads like a verdict; "Optimization" reads like filler.
  const ev = finding.evidence || {};
  if (Number.isFinite(ev.percentOverTarget) && ev.percentOverTarget > 0) {
    return `${Math.round(ev.percentOverTarget)}% over target`;
  }
  const segCpa = Number(ev.segmentCpa);
  const baseCpa = Number(ev.baselineCpa);
  if (Number.isFinite(segCpa) && Number.isFinite(baseCpa) && baseCpa > 0 && segCpa > baseCpa) {
    const pct = Math.round(((segCpa - baseCpa) / baseCpa) * 100);
    if (pct >= 10) return `${pct}% over ${/target/i.test(context) ? "target" : "baseline"}`;
  }
  if (Number.isFinite(ev.deadCampaignCount) && ev.deadCampaignCount > 0) {
    return `${ev.deadCampaignCount} idle campaigns`;
  }
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
    // Underscores are key debris; hyphens are legitimate prose ("re-enable",
    // "post-click", "-100%") and must survive.
    .replace(/_+/g, " ")
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
  const text = String(value ?? "").replace(/_+/g, " ").trim();
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

/** A campaign is paused/inactive unless its status clearly says it's delivering. */
const isPausedCampaign = (c) => {
  const s = String(c.status || "").toUpperCase();
  return /PAUSE|ARCHIV|DELETED|DISABLED|OFF\b|NOT_DELIVERING/.test(s);
};

const sumCampaignMetrics = (campaigns) =>
  campaigns.reduce(
    (acc, c) => {
      acc.spend += num(c.spend);
      acc.impressions += num(c.impressions);
      acc.clicks += num(c.clicks);
      acc.conversions += num(c.results ?? c.conversions);
      return acc;
    },
    { spend: 0, impressions: 0, clicks: 0, conversions: 0 }
  );

/**
 * Audit scope. We pull ALL campaigns (active + paused) so the report shows the
 * full picture, then splits the figures three ways — total, active subtotal,
 * paused subtotal — so the client sees exactly which spend/results came from live
 * campaigns versus paused ones. The per-campaign COMPARISON focuses on the active
 * set (what can still be optimised); the breakdown discloses the paused portion.
 *
 * Defensive: an account that was entirely paused during the window is not a bug —
 * `hasPaused`/`hasActive` flags let the report adapt rather than blank out.
 *
 * @returns {{ active, paused, hasPaused, hasActive,
 *   activeTotals, pausedTotals, totalTotals }}
 */
const getCampaignScope = (audit) => {
  const platforms = audit.normalizedDataset?.data?.platforms || {};
  const campaigns = [];
  for (const p of Object.values(platforms)) {
    for (const c of p?.byLevel?.campaign || []) {
      if (num(c.spend) > 0) campaigns.push(c);
    }
  }
  const active = campaigns.filter((c) => !isPausedCampaign(c));
  const paused = campaigns.filter((c) => isPausedCampaign(c));
  return {
    active,
    paused,
    hasPaused: paused.length > 0,
    hasActive: active.length > 0,
    activeTotals: sumCampaignMetrics(active),
    pausedTotals: sumCampaignMetrics(paused),
    totalTotals: sumCampaignMetrics(campaigns),
  };
};

/**
 * The Active vs Paused breakdown — shows the total split into what came from live
 * campaigns versus paused ones, so the headline figures are transparent about
 * their composition. Only rendered when both an active and a paused-with-spend
 * cohort exist (otherwise there is nothing to split).
 */
const scopeBreakdownSection = (scope, currency) => {
  if (!scope.hasPaused || !scope.hasActive) return null;
  const row = (label, t, count) => [label, t.spend, String(Math.round(t.conversions)), String(count)];
  return {
    id: "scope-breakdown",
    eyebrow: "Data scope",
    title: "Active vs paused campaigns",
    intro:
      "The audit reviews every campaign that spent in this period. The totals are split below so you can see what came from live campaigns versus paused ones — the per-campaign comparison and the recommendations focus on the active set you can still optimise.",
    blocks: [
      {
        type: "data_table",
        columns: [
          { header: "Campaigns", align: "left" },
          { header: "Spend", align: "right", width: "120px" },
          { header: "Conversions", align: "right", width: "110px" },
          { header: "Count", align: "right", width: "80px" },
        ],
        currency,
        rows: [
          row("Active", scope.activeTotals, scope.active.length),
          row("Paused", scope.pausedTotals, scope.paused.length),
          row("Total", scope.totalTotals, scope.active.length + scope.paused.length),
        ],
        footnote:
          "Active = currently delivering. Paused = spent earlier in the window but not delivering now. Recommendations target the active set.",
      },
    ],
  };
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
  // categoryMeta (written by the engine next to `categories`) carries each
  // category's basis: how many findings produced the score, and whether the
  // account has data the category could be scored on at all. A category that is
  // not applicable (e.g. "Keyword Strategy" on a Display-only account with no
  // keyword targeting) is dropped rather than shown with an unexplained number.
  const walk = (value, path = [], metaByCategory = null) => {
    if (typeof value === "number" && value >= 0 && value <= 100) {
      const last = path[path.length - 1];
      if (/^(overall|score|findingCount)$/i.test(last || "")) return;
      const categoryIndex = path.findIndex((p) => p === "categories");
      const labelPath = categoryIndex >= 0 ? path.slice(categoryIndex + 1) : path;
      const label = labelPath.join(" ");
      const meta = metaByCategory?.[last] || null;
      if (meta && meta.applicable === false) return;
      rows.push({ label: label || "Score", value, findingCount: meta?.findingCount ?? null });
      return;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const nextMeta =
      value.categoryMeta && typeof value.categoryMeta === "object" ? value.categoryMeta : null;
    Object.entries(value).forEach(([key, child]) => {
      if (key === "categoryMeta") return;
      walk(child, [...path, key], key === "categories" ? nextMeta || metaByCategory : metaByCategory);
    });
  };
  walk(scores);
  return rows
    .filter((row) => row.label && !/^platforms$/i.test(row.label))
    .slice(0, 10)
    .map(({ label, value, findingCount }) => ({
      // The basis is part of the label so every score has a visible reason:
      // "Bidding Strategy Alignment · 3 findings — 14" is explained; a bare
      // "92" is not.
      label:
        findingCount != null
          ? `${cleanReportText(label)} · ${findingCount === 0 ? "no findings" : `${findingCount} finding${findingCount === 1 ? "" : "s"}`}`
          : cleanReportText(label),
      value,
      max: 100,
      tone: value < 85 ? "warn" : "brand",
      display: String(value),
    }));
};

// netRecoverable is hidden because it duplicates the "Recoverable spend" row the
// table already leads with; leadsSeverityBand/confidentlyBetter are internal
// ranking flags, not client-facing evidence.
const hiddenEvidenceKeys = new Set([
  "id", "ruleId", "rule_id", "module", "version", "currency", "dimension",
  "netRecoverable", "leadsSeverityBand", "confidentlyBetter",
]);

const evidenceValue = (key, value, currency) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    // CVR/CTR evidence is stored as a percent number (bestCvr: 3.63 = 3.63%) —
    // without this branch it fell through to Math.round and printed "4".
    if (/c[vt]r/i.test(key)) return `${Number(value.toFixed(2)).toLocaleString("en-US")}%`;
    if (/roas/i.test(key)) return `${Number(value.toFixed(2)).toLocaleString("en-US")}×`;
    if (/pct|percent|rate/i.test(key)) return `${Number(value.toFixed(1)).toLocaleString("en-US")}%`;
    // A key naming a COUNT is never money even when it also contains a money
    // word — "spendingAdSets: 11" must print "11", not "PKR 11".
    if (/(count|number|sets|groups|campaigns|keywords|items|segments|days)/i.test(key)) {
      return Math.round(value).toLocaleString("en-US");
    }
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
  // Use the RECONCILED net, never a figure scraped from the narrative — an
  // advisory/diagnostic finding mentions a target/CPA value that is not recovered
  // money (e.g. "Closing the gap to the PKR 160 target" must not print
  // "Recoverable spend PKR 160").
  const amount =
    isDiagnostic(finding) || finding.evidence?.advisory === true ? 0 : findingRecoverable(finding);
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

// One short takeaway — ONLY when it carries a concrete number (recoverable money
// or blocked delivery). The generic "removes account drag" / "high-leverage
// optimization" lines added length without information on every card, so they are
// dropped (caller skips the block when this returns null).
const takeawayForFinding = (finding, currency) => {
  // Delivery blocks quote RESTORABLE spend from their own narrative (it lives in
  // estimatedImpact, not netRecoverable — it isn't "recoverable waste").
  if (finding.evidence?.blocksDelivery === true) {
    const blocked = moneyMagnitude(finding.estimatedImpact || finding.evidence);
    return blocked > 0
      ? `What this means for you: fixing this restores ${formatMoney(blocked, currency)} of proven delivery that is currently blocked.`
      : null;
  }
  // Everything else uses the RECONCILED net — never a number scraped from the
  // narrative. A "counted above" / diagnostic / advisory finding nets to 0 and
  // gets no recovery takeaway, so a placement finding that merely mentions its
  // PKR 61 CPA can never claim "recover PKR 61".
  if (isDiagnostic(finding) || finding.evidence?.advisory === true) return null;
  const net = findingRecoverable(finding);
  return net > 0
    ? `What this means for you: fixing this can recover ${formatMoney(net, currency)} in the next comparable period.`
    : null;
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
  // No rule-level diagnosis available: emit NOTHING rather than a generic
  // placeholder. A "Why it is happening" line that repeats the same hedge on every
  // finding is the boilerplate a client flagged as long-winded — the caller skips
  // the block when this returns null.
  return null;
};

// ── Creative & copy recommendations ──────────────────────────────────────────
// Data-grounded suggestions on ad copy, creative direction, and ad structure
// (extensions/snippets). Every suggestion cites the account data that motivates
// it — no generic "write better ads" filler; when the account gives no creative
// signal, the section doesn't render.
const creativeSection = (audit, findings, currency) => {
  // Only ads that actually spent — a rating on a zero-spend ad is not evidence,
  // and counting them would contradict the ad-strength finding's own numbers.
  const ads = recordsAtLevel(audit, "ad").filter((a) => a && num(a.spend) > 0);
  const assets = recordsAtLevel(audit, "asset");
  const platform = audit.selectedPlatforms?.[0] || "GOOGLE";
  const network = platform === "GOOGLE" ? resolveGoogleNetwork(audit.normalizedDataset) : null;

  const recommendations = [];

  // 1) Weak Ad Strength — concrete rewrite guidance tied to the rated ads.
  const weakAds = ads.filter((a) => /poor|average/i.test(String(a.adStrength || "")));
  if (weakAds.length) {
    const weakSpend = weakAds.reduce((s, a) => s + num(a.spend), 0);
    const activeCount = ads.length;
    recommendations.push([
      "Ad copy",
      `Rework the ${weakAds.length} ad${weakAds.length === 1 ? "" : "s"} rated below "Good": add more unique headlines (aim for 10+), include the audience's market/language in at least 2 headlines, vary the call-to-action, and unpin headlines so the platform can rotate combinations.`,
      `${weakAds.length} of ${activeCount} ads rated ${[...new Set(weakAds.map((a) => cleanReportText(String(a.adStrength).toLowerCase())))].join("/")} on ${formatMoney(weakSpend, currency)} of spend`,
    ]);
  }

  // 1b) Meta: thin creative rotation + default ad names. With 1–2 ads per
  // campaign the delivery system has nothing to rotate to when the audience
  // fatigues — frequency climbs with no in-campaign relief valve.
  if (platform === "META" && ads.length >= 2) {
    const byCampaign = new Map();
    for (const a of ads) {
      const key = a.campaignName || "—";
      byCampaign.set(key, (byCampaign.get(key) || 0) + 1);
    }
    const thin = [...byCampaign.entries()].filter(([, n]) => n <= 2);
    if (byCampaign.size >= 2 && thin.length >= Math.ceil(byCampaign.size / 2)) {
      recommendations.push([
        "Creative diversity",
        "Run 3–5 ad variants per campaign (different hooks/first lines, at least one video and one static). With only 1–2 ads live, the delivery system has nothing to rotate to when the audience fatigues — frequency climbs and CPM rises with no in-campaign relief valve.",
        `${thin.length} of ${byCampaign.size} spending campaigns run 2 or fewer ads`,
      ]);
    }
    const genericAds = ads.filter((a) => {
      const name = String(a.name || "").trim();
      return /([–—-]\s*copy(\s*\d+)?)$/i.test(name) || /^new leads ad/i.test(name);
    });
    if (ads.length >= 3 && genericAds.length >= Math.ceil(ads.length / 2)) {
      recommendations.push([
        "Ad naming",
        'Name ads by their creative angle (hook | format | date) instead of "– Copy 2". Without it the winning creative cannot be identified at a glance, and the learning is lost when a campaign is archived.',
        `${genericAds.length} of ${ads.length} spending ads use default/copy names`,
      ]);
    }
  }

  // 2) Missing extensions — Search inventory only (extensions don't serve on
  // pure Display), and only when asset data confirms the gap.
  if (platform === "GOOGLE" && network === "SEARCH") {
    const presentTypes = new Set(assets.map((a) => String(a.fieldType || "").toUpperCase()));
    const coreMissing = ["SITELINK", "CALLOUT", "STRUCTURED_SNIPPET"].filter((t) => !presentTypes.has(t));
    if (coreMissing.length) {
      recommendations.push([
        "Ad structure",
        `Add ${coreMissing.map((t) => cleanReportText(t.toLowerCase())).join(", ")} assets: at least 4 sitelinks (top pages/offers), 4 callouts (proof points), and 1–2 structured snippets. They expand the ad at no extra CPC and consistently lift CTR.`,
        assets.length ? `No ${coreMissing.map((t) => t.toLowerCase()).join("/")} assets found in the account` : "No extension assets found in the account",
      ]);
    }
  }

  // 3) Downstream funnel diagnosis → message-match copy work. Grounded in the
  // engine's own post-click findings rather than re-deriving here.
  const postClick = findings.find((f) => /post.click|landing page|downstream/i.test(`${f.title} ${f.detail || ""}`));
  if (postClick) {
    recommendations.push([
      "Message match",
      "Align the ad's promise with the landing page's first screen: the headline the user clicked should be repeated (or directly answered) above the fold, with one visible call-to-action that matches the ad's offer. Test this before spending more on new creative.",
      `Engine finding: ${postClick.title}`,
    ]);
  }

  // 4) CTR below benchmark → creative refresh with the measured gap as basis.
  const ctrFinding = findings.find((f) => f.ruleId === "BENCH-CTR-001" && f.evidence?.actualCtr != null && f.evidence?.benchmarkCtr != null);
  if (ctrFinding) {
    recommendations.push([
      "Creative refresh",
      "Refresh the weakest creative first: replace the lowest-CTR ad in each ad group with a new variant (new hook in the first line, human faces or product-in-use imagery, and a single clear CTA).",
      `Account CTR ${ctrFinding.evidence.actualCtr}% vs ${ctrFinding.evidence.benchmarkCtr}% benchmark`,
    ]);
  }

  // 5) Display/PMax inventory → responsive asset coverage.
  if (platform === "GOOGLE" && (network === "DISPLAY" || network === "PMAX") && ads.length) {
    recommendations.push([
      "Creative coverage",
      "Supply the full responsive asset set: landscape + square + portrait images, logos, and both short and long headlines/descriptions, so the network can serve every placement size instead of auto-cropping or skipping inventory.",
      `Account serves on the ${network === "PMAX" ? "Performance Max" : "Display"} network (${ads.length} active ad${ads.length === 1 ? "" : "s"})`,
    ]);
  }

  if (!recommendations.length) return null;

  return {
    id: "creative-copy",
    eyebrow: "Creative & copy",
    title: "Ad copy and creative recommendations",
    intro: "Suggestions for copy, creative direction, and ad structure — each grounded in what this account's own data shows is weak or missing.",
    blocks: [
      {
        type: "data_table",
        columns: [
          { header: "Area", align: "left", width: "110px" },
          { header: "Recommendation", align: "left" },
          { header: "Based on", align: "left", width: "200px" },
        ],
        currency,
        rows: recommendations.slice(0, 5),
        footnote: "Creative work compounds with the money fixes above — ship the recoverable-spend fixes first, then iterate creative on the surviving campaigns.",
      },
    ],
  };
};

const findingBlock = (finding, currency = "USD", campaignNames = []) => {
  // Every money figure a client sees must be the reconciled net — the engine's
  // prose is rewritten where its gross figure diverges (see netAdjustedText).
  const impact = netAdjustedText(finding.estimatedImpact, finding, currency) || "Business risk identified; the available data does not support a reliable money estimate.";
  const emphasize = (text) => emphasizeCampaignNames(text, campaignNames);
  const proseContext = `${finding.detail || finding.title} ${impact}`;
  const bodyBlocks = [
    {
      type: "paragraph",
      text: `**What is happening:** ${emphasize(finding.detail || finding.title)}`,
    },
  ];
  // "Why it is happening" only when the rule actually diagnosed a cause — no
  // generic hedge repeated on every finding.
  const why = whyText(finding);
  if (why) {
    bodyBlocks.push({ type: "paragraph", text: `**Why it is happening:** ${emphasize(why)}` });
  }
  bodyBlocks.push({
    type: "paragraph",
    text: `**Estimated business impact:** ${emphasize(impact)}`,
  });
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
    // Reconciled net only — never a number scraped from the narrative (an advisory
    // bid-target finding would otherwise print its target CPA as "Recoverable").
    const amount =
      isDiagnostic(finding) || finding.evidence?.advisory === true ? 0 : findingRecoverable(finding);
    const extras = [];
    if (amount > 0) extras.push({ metric: "Recoverable spend", value: formatMoney(amount, currency), target: "—", status: "neutral" });
    const conf = finding.evidence?.confidence;
    if (conf) extras.push({ metric: "Confidence", value: cleanReportText(String(conf)), target: "—", status: "neutral" });
    bodyBlocks.push({ type: "scorecard", rows: [...proofRows, ...extras].slice(0, 6), currency });
  } else {
    const rows = evidenceRows(finding, currency, proseContext);
    if (rows.length) bodyBlocks.push({ type: "evidence_table", rows, proseContext, currency });
  }
  // (Removed the static "Expected outcome after fixing" line — it repeated the
  // same sentence on every finding without adding information.)
  const takeaway = takeawayForFinding(finding, currency);
  if (takeaway) bodyBlocks.push({ type: "takeaway", text: takeaway });

  return {
    type: "finding",
    id: null,
    severity: finding.severity,
    headline: netAdjustedText(finding.title, finding, currency),
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
  const { businessType, source: btSource } = resolveBusinessType(audit, audit.normalizedDataset);
  const platform = audit.selectedPlatforms?.[0] || "GOOGLE";
  // Prefer the declared intake target; otherwise the engine may have inferred one
  // from the campaigns' own Target-CPA settings (stamped on the summary). Track
  // which so the caption can disclose an inferred target honestly.
  const declaredTargetCpa = num(sectionA.targetCpa);
  const inferredTargetCpa = num(
    audit.normalizedDataset?.summary?.platforms?.[platform]?.inferredTargetCpa
  );
  const targetCpa = declaredTargetCpa > 0 ? declaredTargetCpa : inferredTargetCpa;
  const targetInferred = declaredTargetCpa <= 0 && inferredTargetCpa > 0;

  const cpc = clicks > 0 ? spend / clicks : null;
  // Headline CPA uses the anomaly-quarantined baseline: when a campaign reports
  // conversions too cheap to be genuine, the blended spend/conversions understates
  // the real cost per result. accountBaseline() returns the trusted figure.
  const { baselineCpa: trustedCpa, anomalyNames } = accountBaseline(audit, totals);
  const blendedCpa = conversions > 0 ? spend / conversions : null;
  const cpa = trustedCpa != null ? trustedCpa : blendedCpa;
  const hasAnomaly = anomalyNames.size > 0;
  // CTR must also exclude the anomaly's fake clicks — the blended CTR is inflated
  // (e.g. 6% reported vs ~2.4% genuine) and would read "Strong" on a weak account.
  let ctrImpr = impressions;
  let ctrClk = clicks;
  if (hasAnomaly) {
    ctrImpr = 0;
    ctrClk = 0;
    const platforms = audit.normalizedDataset?.data?.platforms || {};
    for (const p of Object.values(platforms)) {
      for (const c of p?.byLevel?.campaign || []) {
        if (anomalyNames.has(normName(c.name))) continue;
        ctrImpr += num(c.impressions);
        ctrClk += num(c.clicks);
      }
    }
  }
  const ctr = ctrImpr > 0 ? (ctrClk / ctrImpr) * 100 : null;

  const rows = [
    { metric: "Total spend", value: formatMoney(spend, currency), target: "—", status: "neutral" },
    { metric: "Conversions", value: Math.round(conversions).toLocaleString("en-US"), target: "—", status: "neutral" },
  ];

  // CTR vs industry benchmark (higher is better). For Google, benchmark against
  // the account's dominant NETWORK (Search vs Display/…) so a Display account's
  // naturally-low CTR isn't scored against a Search bar.
  const scNetwork = platform === "GOOGLE" ? resolveGoogleNetwork(audit.normalizedDataset) : null;
  const ctrBench = getBenchmark("ctr", platform, businessType, scNetwork);
  if (ctr != null && ctrBench) {
    let status = "bad";
    let label = "Below benchmark";
    if (ctr >= ctrBench.good) {
      status = "good";
      // Quantify HOW strong — "17× benchmark" is a verdict, "Strong" is a shrug.
      const mult = ctrBench.warning > 0 ? ctr / ctrBench.warning : null;
      label = mult != null && mult >= 3 ? `Strong — ${Math.round(mult)}× benchmark` : "Strong";
    }
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
      rows.push({ metric: "Cost per acquisition", value: formatMoney(cpa, currency), target: hasAnomaly ? "excl. tracking anomaly" : "—", status: "neutral" });
    }
  }

  const anomalyNote = hasAnomaly
    ? " Cost per acquisition and click-through rate exclude the campaign whose conversions are too cheap to be genuine (see the tracking-integrity finding) — its fake clicks would otherwise understate the real cost and inflate CTR."
    : "";
  // When the declared target sits far below anything any campaign has actually
  // achieved, say so — scoring "236% over target" against a number the account
  // has never seen reads harsher than the data supports.
  let aspirationalNote = "";
  if (declaredTargetCpa > 0 && cpa != null) {
    let bestProvenCpa = null;
    const platformsData = audit.normalizedDataset?.data?.platforms || {};
    for (const p of Object.values(platformsData)) {
      for (const c of p?.byLevel?.campaign || []) {
        if (anomalyNames.has(normName(c.name))) continue;
        const conv = num(c.results ?? c.conversions);
        if (conv < 20) continue;
        const campCpa = c.cpa != null ? num(c.cpa) : num(c.spend) / conv;
        if (campCpa > 0 && (bestProvenCpa == null || campCpa < bestProvenCpa)) bestProvenCpa = campCpa;
      }
    }
    if (bestProvenCpa != null && declaredTargetCpa < bestProvenCpa * 0.6) {
      aspirationalNote = ` Note: no campaign has proven better than ${formatMoney(bestProvenCpa, currency)} per result on real volume — treat that as the near-term achievable bar; your ${formatMoney(declaredTargetCpa, currency)} target is aspirational.`;
    }
  }
  // Disclose where the benchmark business type came from so a wrong one is
  // visible and fixable: declared in the profile, or detected from the data.
  const btQualifier =
    btSource === "detected"
      ? `${businessType} (detected from your account's objectives — set it in your profile if that's not right)`
      : btSource === "declared"
        ? `${businessType} (from your profile)`
        : businessType;
  const caption =
    (targetCpa > 0
      ? targetInferred
        ? `CPA target (${formatMoney(targetCpa, currency)}) inferred from your campaigns' own Target-CPA settings — set an account target in intake to score against your actual goal; CTR benchmark for ${btQualifier} on ${platformLabels[platform] || platform}.`
        : `CPA target (${formatMoney(targetCpa, currency)}) from your intake; CTR benchmark for ${btQualifier} on ${platformLabels[platform] || platform}.`
      : `CTR benchmark for ${btQualifier} on ${platformLabels[platform] || platform}. Set a target CPA in intake to score CPA against it.`) +
    anomalyNote +
    aspirationalNote;

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
const campaignStatus = (c, baselineCpa, isAnomaly = false, comparable = true) => {
  const status = String(c.status || "").toUpperCase();
  const results = num(c.results ?? c.conversions);
  const spend = num(c.spend);
  const cpa = c.cpa != null ? num(c.cpa) : results > 0 ? spend / results : null;
  // A tracking-anomaly campaign looks like the best performer (implausibly cheap)
  // — never badge it "good"/scale; flag it for verification.
  if (isAnomaly) return { status: "bad", text: "Tracking?" };
  if (/DISAPPROVED/.test(status)) return { status: "bad", text: "Blocked" };
  // Zero-conversion material spend is a problem regardless of cohort. But a
  // converting campaign with no comparable peers (a singleton conversion type)
  // cannot honestly be called over/under baseline — stay neutral.
  if (results > 0 && !comparable) return { status: "neutral", text: "No peer" };
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
const campaignVerdict = (c, baselineCpa, isAnomaly = false, comparable = true) => {
  const status = String(c.status || "").toUpperCase();
  const results = num(c.results ?? c.conversions);
  const spend = num(c.spend);
  const cpa = c.cpa != null ? num(c.cpa) : results > 0 ? spend / results : null;

  if (isAnomaly) {
    return "Conversions too cheap to be genuine — verify the conversion event before trusting or scaling this campaign.";
  }
  if (/DISAPPROVED/.test(status)) {
    return "Disapproved — blocked from delivering; restoring it is the priority.";
  }
  if (results === 0 && spend >= campaignDispersionMaterial) {
    return "Material spend, zero conversions — likely a targeting or geo misconfiguration.";
  }
  if (results > 0 && !comparable) {
    return "The only campaign of its conversion type — no comparable peer to judge its cost against. Track it against your own target, not the account average.";
  }
  // A campaign missing its OWN Target-CPA setting by half or more is judged
  // against that first — it's the goal the client already chose for it.
  const ownTarget = num(c.targetCpa);
  if (ownTarget > 0 && cpa && cpa >= ownTarget * 1.5) {
    return `Paying ${(cpa / ownTarget).toFixed(1)}× its own Target-CPA setting — bring it back to its goal or stop funding it.`;
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
 * "What's working" — the account's proven strengths, stated with the same
 * numeric discipline as the problems. An audit that is 100% complaint reads
 * like a sales pitch; naming what to protect (and what to re-enable) is half
 * the value of a senior review. Built only from measured winners: campaigns
 * with real volume at/below the account average, and devices beating it.
 */
const whatsWorkingSection = (audit, currency, totals, findings = []) => {
  const { baselineCpa, anomalyNames } = accountBaseline(audit, totals);
  if (!baselineCpa) return null;
  const rows = [];

  // A winner that carries its own open finding (e.g. "saturating its audience
  // at 3.24× frequency") must not get an unqualified "protect and scale" — the
  // caveat keeps this section from contradicting the findings list.
  const openFindingFor = (name) =>
    findings.find(
      (f) =>
        ["CRITICAL", "HIGH", "MEDIUM"].includes(f.severity) &&
        (f.evidence?.campaign === name || (name && String(f.title || "").includes(name)))
    );
  const caveatFor = (name) => {
    const open = openFindingFor(name);
    if (!open) return "";
    const clause = String(open.title || "")
      .replace(name, "")
      .replace(/^[\s—:–-]+/, "")
      .trim();
    return clause ? ` But note: it ${clause} — address that finding before scaling further.` : "";
  };

  const platforms = audit.normalizedDataset?.data?.platforms || {};
  const campaigns = [];
  for (const p of Object.values(platforms)) {
    for (const c of p?.byLevel?.campaign || []) campaigns.push(c);
  }

  const winners = campaigns
    .filter((c) => !anomalyNames.has(normName(c.name)))
    .map((c) => {
      const conv = num(c.results ?? c.conversions);
      return {
        name: c.name || "(unnamed campaign)",
        conv,
        paused: isPausedCampaign(c),
        cpa: c.cpa != null ? num(c.cpa) : conv > 0 ? num(c.spend) / conv : null,
      };
    })
    // Strictly at/below the account average — the campaign table calls anything
    // above it "room to tighten", and this section must never contradict that.
    .filter((w) => w.conv >= 20 && w.cpa != null && w.cpa <= baselineCpa)
    .sort((a, b) => a.cpa - b.cpa)
    .slice(0, 3);
  for (const w of winners) {
    rows.push([
      w.paused ? `"${w.name}" — proven winner, currently paused` : `"${w.name}" — carrying the account's efficiency`,
      `${formatMoney(w.cpa, currency)} per result on ${Math.round(w.conv)} conversions, vs the ${formatMoney(baselineCpa, currency)} account average`,
      (w.paused
        ? "Re-enable it — a campaign that already proved this cost is the fastest efficiency win available."
        : "Protect its targeting and budget; scale in ~20% steps while the cost per result holds.") +
        caveatFor(w.name),
    ]);
  }

  const deviceRecs = recordsAtLevel(audit, "campaign_device")
    .concat(recordsAtLevel(audit, "device"))
    .map((r) => ({
      campaign: r.campaignName || "—",
      device: r.device || r.deviceType || "—",
      spend: num(r.spend),
      conv: num(r.conversions ?? r.results),
    }));
  // Per-campaign device spend, to spot a MINORITY device outperforming. The
  // dominant device (mobile at 95% of a campaign) IS the campaign — calling it
  // a separate strength would just repeat the campaign row above.
  const campaignDeviceSpend = new Map();
  for (const r of deviceRecs) {
    campaignDeviceSpend.set(r.campaign, (campaignDeviceSpend.get(r.campaign) || 0) + r.spend);
  }
  const devWinners = deviceRecs
    .filter((r) => r.conv >= 3 && r.spend > 0)
    .map((r) => ({ ...r, cpa: r.spend / r.conv, share: r.spend / (campaignDeviceSpend.get(r.campaign) || r.spend) }))
    .filter((r) => r.cpa <= baselineCpa * 0.75 && r.share < 0.5)
    .sort((a, b) => a.cpa - b.cpa)
    .slice(0, 2);
  for (const d of devWinners) {
    rows.push([
      `${cleanSegmentValue(d.device)} in "${d.campaign}" beats the account average`,
      `${formatMoney(d.cpa, currency)} per result on ${Math.round(d.conv)} conversions, vs the ${formatMoney(baselineCpa, currency)} account average`,
      "Test a positive bid adjustment (+10–20%) on this device in this campaign.",
    ]);
  }

  if (!rows.length) return null;
  return {
    id: "whats-working",
    eyebrow: "What's working",
    title: "The strengths to protect",
    intro:
      "Not everything in the account is a problem. These are the measured winners — the campaigns and segments already performing at or better than the account average — and the move that protects each one.",
    blocks: [
      {
        type: "data_table",
        columns: [
          { header: "Strength", align: "left" },
          { header: "The numbers", align: "left" },
          { header: "Keep doing", align: "left" },
        ],
        currency,
        rows: rows.slice(0, 5),
        footnote: "Winners are judged on real conversion volume against the account average — not on impressions or clicks alone.",
      },
    ],
  };
};

/**
 * The per-campaign performance section — the spine of a consultant-grade audit.
 * A flat findings list tells the client WHAT is wrong; this shows them every
 * campaign's numbers and a verdict, which is what reads as expert review.
 * Returns null when there isn't a meaningful multi-campaign breakdown.
 */
const MAX_COMPARISON_ROWS = 40; // safety cap so a sprawling account can't bloat the PDF

const campaignDeepDiveSection = (audit, currency, totals, scope) => {
  const platforms = audit.normalizedDataset?.data?.platforms || {};
  let rows = [];
  for (const platform of Object.values(platforms)) {
    for (const c of platform?.byLevel?.campaign || []) {
      if (num(c.spend) > 0) rows.push(c);
    }
  }
  // Scope the comparison to the campaigns the client can act on: when active
  // campaigns exist, compare ALL of them (the paused cohort is disclosed in the
  // Active vs Paused breakdown). All-paused accounts fall back to showing those.
  // With fewer than 2 active campaigns the active-only view collapses — exactly
  // the "live on one loser while winners sit paused" account shape where this
  // table matters most — so widen back to every campaign that spent; the Status
  // column carries the active/paused distinction.
  let activeScoped = scope?.hasActive;
  if (activeScoped && scope.active.length >= 2) rows = scope.active;
  else activeScoped = false;
  if (rows.length < 2) return null;

  // Baseline from the same cohort being compared (active when scoped), so it isn't
  // skewed by paused spend the comparison no longer shows.
  const baseTotals = activeScoped ? scope.activeTotals : totals;
  const { baselineCpa, anomalyNames } = accountBaseline(audit, baseTotals);

  // Per-campaign baselines by conversion type: each campaign is judged only
  // against peers buying the same kind of result (a Telegram conversation vs a
  // website lead). Anomaly campaigns are excluded so their fake-cheap CPA can't
  // drag a cohort. A campaign with no comparable peers gets no over/under verdict.
  const cohorts = buildCohortBaselines(rows.filter((c) => !anomalyNames.has(normName(c.name))));

  // Show ALL (active) campaigns, not just the top few — the full comparison the
  // client asked for — capped only so a huge account can't blow up the document.
  const ranked = rows.sort((a, b) => num(b.spend) - num(a.spend)).slice(0, MAX_COMPARISON_ROWS);

  // Bidding column — strategy + its set target ("tCPA PKR 160"), the setting a
  // strategist reads first when a campaign misses its own goal.
  const biddingCell = (c) => {
    const strategy = String(c.bidStrategy || "").toUpperCase();
    const tCpa = num(c.targetCpa);
    const tRoas = num(c.targetRoas);
    if (strategy.includes("TARGET_CPA") || (tCpa > 0 && !strategy)) {
      return tCpa > 0 ? `tCPA ${formatMoney(tCpa, currency)}` : "Target CPA";
    }
    if (strategy.includes("TARGET_ROAS")) return tRoas > 0 ? `tROAS ${tRoas.toFixed(1)}×` : "Target ROAS";
    if (strategy.includes("MAXIMIZE_CONVERSION_VALUE")) return "Max Conv Value";
    if (strategy.includes("MAXIMIZE_CONVERSIONS")) return "Max Conversions";
    if (strategy.includes("MANUAL")) return "Manual CPC";
    return strategy ? cleanReportText(strategy.toLowerCase()) : "—";
  };

  // Mixed live+paused view (we widened because <2 campaigns are active): the
  // pill must say WHICH rows are live — "the account is live on its worst
  // performer" is unreadable without it. Tone still reflects performance, so a
  // green "Paused" pill reads as a parked winner and a red "Live" as the leak.
  const mixedScope = !activeScoped && scope?.hasActive;

  const tableRows = ranked.map((c) => {
    const results = num(c.results ?? c.conversions);
    const cpa = c.cpa != null ? num(c.cpa) : results > 0 ? num(c.spend) / results : null;
    const isAnomaly = anomalyNames.has(normName(c.name));
    const cohortBase = cohortBaselineFor(c, cohorts);
    const comparable = cohortBase != null;
    const perf = campaignStatus(c, cohortBase ?? baselineCpa, isAnomaly, comparable); // { status, text }
    const statusCell = mixedScope
      ? { status: perf.status, text: isPausedCampaign(c) ? "Paused" : "Live" }
      : perf;
    return [
      c.name || "(unnamed campaign)",
      biddingCell(c),
      num(c.spend),
      String(Math.round(results)),
      cpa != null ? formatMoney(cpa, currency) : "—",
      statusCell,
      campaignVerdict(c, cohortBase ?? baselineCpa, isAnomaly, comparable),
    ];
  });

  const pausedNote =
    activeScoped && scope.hasPaused
      ? ` ${scope.paused.length} paused campaign${scope.paused.length === 1 ? "" : "s"} ${scope.paused.length === 1 ? "is" : "are"} shown separately in the Active vs Paused breakdown.`
      : "";
  const scopeIntro = activeScoped
    ? `All ${ranked.length} active campaign${ranked.length === 1 ? "" : "s"} compared against the active baseline` +
      (baselineCpa ? ` (cost per result ${formatMoney(baselineCpa, currency)})` : "") +
      `.${pausedNote}`
    : "Each campaign's own numbers against the account baseline" +
      (baselineCpa ? ` (cost per result ${formatMoney(baselineCpa, currency)})` : "") +
      " — so the diagnosis is grounded in per-campaign performance, not a blended average.";

  return {
    id: "campaign-deep-dive",
    eyebrow: "Campaign performance",
    title: activeScoped ? "Every active campaign, compared" : "Every campaign, with a verdict",
    intro: scopeIntro,
    blocks: [
      {
        type: "data_table",
        columns: [
          { header: "Campaign", align: "left" },
          { header: "Bidding", align: "left", width: "104px" },
          { header: "Spend", align: "right", width: "92px" },
          { header: "Results", align: "right", width: "64px" },
          { header: "Cost / result", align: "right", width: "100px" },
          { header: "Status", align: "left", width: "96px" },
          { header: "Verdict", align: "left" },
        ],
        currency,
        rows: tableRows,
        footnote: activeScoped
          ? "Cost per result uses each campaign's own conversions; the verdict compares it to the active baseline. Comparison covers active campaigns; the paused total is in the Active vs Paused breakdown."
          : "Cost per result uses each campaign's own conversions; the verdict compares it to the account baseline. Paused campaigns that spent in the window are included — their status column says so.",
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
const campaignCardsSection = (audit, currency, totals, scope) => {
  const platforms = audit.normalizedDataset?.data?.platforms || {};
  let all = [];
  for (const platform of Object.values(platforms)) {
    for (const c of platform?.byLevel?.campaign || []) {
      if (num(c.spend) > 0) all.push(c);
    }
  }
  // Same widening as the deep-dive table: with <2 active campaigns the cards
  // section would vanish exactly when the paused-winner comparison matters most.
  let activeScoped = scope?.hasActive;
  if (activeScoped && scope.active.length >= 2) all = scope.active; // top active campaigns only
  else activeScoped = false;
  if (all.length < 2) return null;

  const { baselineCpa, anomalyNames } = accountBaseline(audit, activeScoped ? scope.activeTotals : totals);
  const sectionA = audit.businessProfileSnapshot?.sectionA || {};
  const { businessType } = resolveBusinessType(audit, audit.normalizedDataset);
  const platform = audit.selectedPlatforms?.[0] || "GOOGLE";
  // Declared intake target, else the engine's inferred target (campaign tCPAs).
  const targetCpa =
    num(sectionA.targetCpa) ||
    num(audit.normalizedDataset?.summary?.platforms?.[platform]?.inferredTargetCpa);
  const ccNetwork = platform === "GOOGLE" ? resolveGoogleNetwork(audit.normalizedDataset) : null;
  const ctrBench = getBenchmark("ctr", platform, businessType, ccNetwork);
  // Per-conversion-type baselines (anomalies excluded) — a campaign's cost is
  // judged against peers buying the same kind of result, not a blended average.
  const cohorts = buildCohortBaselines(all.filter((c) => !anomalyNames.has(normName(c.name))));

  // When the declared target sits far below anything the account has proven
  // (PKR 40 target, best campaign PKR 104), scoring every card "709% over" and
  // demanding a 54% conversion rate is noise, not analysis. Score cards against
  // the achievable bar instead; the scorecard's aspirational note tells the
  // target story once.
  let bestProvenCpa = null;
  for (const c of all) {
    if (anomalyNames.has(normName(c.name))) continue;
    const conv = num(c.results ?? c.conversions);
    if (conv < 20) continue;
    const campCpa = c.cpa != null ? num(c.cpa) : num(c.spend) / conv;
    if (campCpa > 0 && (bestProvenCpa == null || campCpa < bestProvenCpa)) bestProvenCpa = campCpa;
  }
  const targetAspirational = targetCpa > 0 && bestProvenCpa != null && targetCpa < bestProvenCpa * 0.6;

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

    const isAnomaly = anomalyNames.has(normName(c.name));
    const cohortBase = cohortBaselineFor(c, cohorts);
    const comparable = cohortBase != null;
    if (cpa != null) {
      // Prefer the client's declared target — unless it's aspirational (below
      // anything proven), in which case the achievable bar scores the card.
      // Otherwise the campaign's cohort (like-for-like) baseline. Never the
      // blended cross-type average.
      const ref = targetAspirational
        ? (cohortBase ?? bestProvenCpa)
        : targetCpa > 0
          ? targetCpa
          : cohortBase;
      if (isAnomaly) {
        // An implausibly-cheap CPA here is a tracking artifact, not "on target".
        metrics.push({ metric: "Cost per result", value: formatMoney(cpa, currency), target: "verify event", status: "bad", statusLabel: "Tracking?" });
      } else if (ref && ref > 0) {
        const ratio = cpa / ref;
        let status = "good";
        let label = "On target";
        if (ratio > 1.5) { status = "bad"; label = `${Math.round((ratio - 1) * 100)}% over`; }
        else if (ratio > 1.1) { status = "warn"; label = `${Math.round((ratio - 1) * 100)}% over`; }
        metrics.push({ metric: "Cost per result", value: formatMoney(cpa, currency), target: `vs ${formatMoney(ref, currency)}${targetAspirational ? " achievable" : ""}`, status, statusLabel: label });
      } else {
        // No declared target and no comparable peer — show the cost, don't judge it.
        metrics.push({ metric: "Cost per result", value: formatMoney(cpa, currency), target: comparable ? "—" : "no peer", status: "neutral" });
      }
    }

    // Conversion-rate math: the CVR a campaign needs to hit its CPA target at its
    // current click cost (required CVR = CPC ÷ target CPA) vs what it actually
    // converts. This isolates the post-click gap per campaign — the difference
    // between "nearly there" (BD) and a structural problem (PK at 15× off).
    const cvr = !isAnomaly && clicks > 0 && results > 0 ? (results / clicks) * 100 : null;
    const cpc = clicks > 0 ? spend / clicks : null;
    const cvrRef = targetAspirational
      ? (cohortBase ?? bestProvenCpa)
      : targetCpa > 0
        ? targetCpa
        : cohortBase;
    if (cvr != null) {
      const requiredCvr = cpc != null && cvrRef && cvrRef > 0 ? (cpc / cvrRef) * 100 : null;
      if (requiredCvr != null && requiredCvr > 0) {
        const gap = requiredCvr / cvr;
        let status = "good";
        let label = "On track";
        if (gap >= 1.5) { status = "bad"; label = `${gap.toFixed(1)}× short`; }
        else if (gap >= 1.1) { status = "warn"; label = `${Math.round((gap - 1) * 100)}% short`; }
        metrics.push({ metric: "Conversion rate", value: `${cvr.toFixed(2)}%`, target: `need ${requiredCvr.toFixed(2)}%`, status, statusLabel: label });
      } else {
        metrics.push({ metric: "Conversion rate", value: `${cvr.toFixed(2)}%`, target: "—", status: "neutral" });
      }
    }

    // Frequency (Meta/TikTok pulls carry it; Google leaves it null) — the
    // saturation tell. The reference audit reads CPM inflation off this number.
    const freq = num(c.frequency);
    if (freq > 0) {
      let status = "good";
      let label = "Healthy";
      if (freq >= 3) { status = "bad"; label = "Saturating"; }
      else if (freq >= 2.5) { status = "warn"; label = "Elevated"; }
      metrics.push({ metric: "Frequency", value: `${freq.toFixed(2)}×`, target: "< 2.5×", status, statusLabel: label });
    }
    const cpm = num(c.cpm) || (impressions > 0 ? (spend / impressions) * 1000 : null);
    const accountCpm = num(totals.impressions) > 0 ? (num(totals.spend) / num(totals.impressions)) * 1000 : null;
    if (cpm != null && cpm > 0 && accountCpm > 0) {
      let status = "neutral";
      let label = "Near account avg";
      if (cpm <= accountCpm * 0.8) { status = "good"; label = "Below account avg"; }
      else if (cpm >= accountCpm * 1.3) { status = "warn"; label = `${Math.round((cpm / accountCpm - 1) * 100)}% above avg`; }
      metrics.push({ metric: "CPM", value: formatMoney(cpm, currency), target: `vs ${formatMoney(accountCpm, currency)} avg`, status, statusLabel: label });
    }

    // Status / verdict judge the campaign against like-for-like peers (its cohort
    // baseline), falling back to the blended baseline only when no cohort applies.
    // The per-metric "Cost per result" row above already scores against the target.
    const statusBase = cohortBase ?? baselineCpa;
    const st = campaignStatus(c, statusBase, isAnomaly, comparable);
    return {
      type: "campaign_card",
      name: c.name || "(unnamed campaign)",
      status: st.status,
      status_label: st.text,
      spend: formatMoney(spend, currency),
      metrics,
      verdict: campaignVerdict(c, statusBase, isAnomaly, comparable),
      steps: isAnomaly
        ? [
            "Verify the conversion event in the platform before trusting this campaign's results.",
            "If it is a button tap / click-to-chat or wrong pixel event, fix the event mapping — do not scale on these numbers.",
            "Re-baseline the account once the event is corrected.",
          ]
        : campaignNextSteps(c, statusBase),
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
      action: `**${netAdjustedText(f.title, f, currency)}:** ${(Array.isArray(f.fixSteps) && f.fixSteps[0]) || "Apply the recommended fix in the platform."}`,
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

// ── Dimensional breakdown tables ──────────────────────────────────────────────
// Owned per-dimension tables (geo, device, audience segment, funnel CVR) that a
// senior audit presents as their own sections — matching the reference expert
// report. Each reads directly from the normalized dataset and returns null when
// the underlying grain wasn't pulled, so a thin account degrades gracefully.

const MAX_DIM_ROWS = 12;
// A campaign needs at least this many clicks for its CVR to be a meaningful funnel
// signal (below it, CVR is small-sample noise — a test campaign with 8 clicks).
const MIN_FUNNEL_CLICKS = 50;

// Collect records at a byLevel grain across every platform.
const recordsAtLevel = (audit, level) => {
  const platforms = audit.normalizedDataset?.data?.platforms || {};
  const out = [];
  for (const p of Object.values(platforms)) {
    for (const r of p?.byLevel?.[level] || []) out.push(r);
  }
  return out;
};

const cpaCell = (spend, conv, currency) =>
  conv > 0 ? formatMoney(spend / conv, currency) : "—";
const pctCell = (n, d) => (d > 0 ? `${((n / d) * 100).toFixed(2)}%` : "—");

// Geographic breakdown — country × campaign, flags the intended-market vs leak
// distinction in the note so the reader never reads "convert poorly" as "exclude".
const geoBreakdownSection = (audit, currency, totals) => {
  const recs = recordsAtLevel(audit, "geo");
  if (recs.length < 2) return null;
  const baseCpa = num(totals.conversions) > 0 ? num(totals.spend) / num(totals.conversions) : null;
  const totalSpend = num(totals.spend);
  const rows = recs
    .map((r) => ({
      country: r.country || r.countryId || "—",
      campaign: r.campaignName || "—",
      spend: num(r.spend),
      conv: num(r.conversions ?? r.results),
      clicks: num(r.clicks),
    }))
    // Materiality floor: PKR 10 in a market with zero conversions is noise, not
    // a "Zero conversions" verdict — keep small rows only when they converted.
    .filter((r) => r.spend > 0 && (r.conv >= 3 || r.spend >= totalSpend * 0.005))
    .sort((a, b) => b.spend - a.spend)
    .slice(0, MAX_DIM_ROWS);
  if (rows.length < 2) return null;
  const tableRows = rows.map((r) => {
    const cpa = r.conv > 0 ? r.spend / r.conv : null;
    let note = "On baseline";
    if (r.conv === 0) note = "Zero conversions";
    else if (baseCpa && cpa >= baseCpa * 2) note = `${(cpa / baseCpa).toFixed(1)}× baseline`;
    else if (baseCpa && cpa <= baseCpa) note = "At/under baseline";
    return [r.country, r.campaign, formatMoney(r.spend, currency), String(Math.round(r.conv)), cpaCell(r.spend, r.conv, currency), note];
  });
  return {
    id: "geo-breakdown",
    eyebrow: "Geographic",
    title: "Where the spend lands, by market",
    intro: "Spend and cost per result by country. A market named in the campaign is intended — a high cost there is a funnel/targeting-precision issue, not a market to exclude.",
    blocks: [
      {
        type: "data_table",
        columns: [
          { header: "Country", align: "left" },
          { header: "Campaign", align: "left" },
          { header: "Spend", align: "right", width: "96px" },
          { header: "Results", align: "right", width: "70px" },
          { header: "Cost / result", align: "right", width: "104px" },
          { header: "Note", align: "left", width: "120px" },
        ],
        currency,
        rows: tableRows,
        footnote: "Cost per result uses each market's own conversions; the note compares it to the account baseline.",
      },
    ],
  };
};

// Device breakdown — campaign × device, surfaces zero-conversion waste AND an
// over-performing device as a scale opportunity (the reference's IND-tablet call).
const deviceBreakdownSection = (audit, currency, totals) => {
  // The Google pull stores per-campaign device rows at level "campaign_device";
  // the bare "device" level only exists on some older/Meta datasets. Looking up
  // only "device" silently dropped this whole section on Google accounts.
  const recs = recordsAtLevel(audit, "campaign_device").concat(recordsAtLevel(audit, "device"));
  if (recs.length < 2) return null;
  const baseCpa = num(totals.conversions) > 0 ? num(totals.spend) / num(totals.conversions) : null;
  const totalSpend = num(totals.spend);
  const rows = recs
    .map((r) => ({
      campaign: r.campaignName || "—",
      device: r.device || r.deviceType || "—",
      spend: num(r.spend),
      conv: num(r.conversions ?? r.results),
    }))
    // Materiality floor: a PKR 10 slice with zero conversions is statistical
    // noise, not evidence — keep a small row only when it actually converted.
    .filter((r) => r.spend > 0 && (r.conv >= 3 || r.spend >= totalSpend * 0.005))
    .sort((a, b) => b.spend - a.spend)
    .slice(0, MAX_DIM_ROWS);
  if (rows.length < 2) return null;
  const tableRows = rows.map((r) => {
    const cpa = r.conv > 0 ? r.spend / r.conv : null;
    let note = "On baseline";
    if (r.conv === 0) note = `${formatMoney(r.spend, currency)} wasted`;
    else if (baseCpa && cpa <= baseCpa * 0.75) note = "Beats baseline — scale";
    else if (baseCpa && cpa >= baseCpa * 2) note = "Well over baseline";
    return [r.campaign, r.device, formatMoney(r.spend, currency), String(Math.round(r.conv)), cpaCell(r.spend, r.conv, currency), note];
  });
  return {
    id: "device-breakdown",
    eyebrow: "Device",
    title: "How each device converts",
    intro: "Cost per result by device. Zero-conversion devices are pure waste (exclude them); a device beating baseline is a scale opportunity.",
    blocks: [
      {
        type: "data_table",
        columns: [
          { header: "Campaign", align: "left" },
          { header: "Device", align: "left", width: "84px" },
          { header: "Spend", align: "right", width: "96px" },
          { header: "Results", align: "right", width: "70px" },
          { header: "Cost / result", align: "right", width: "104px" },
          { header: "Note", align: "left", width: "128px" },
        ],
        currency,
        rows: tableRows,
        footnote: "A device modifier concentrates budget on what converts; set −100% on zero-conversion devices.",
      },
    ],
  };
};

const dimensionRecords = (audit, dimension) => {
  const platforms = audit.normalizedDataset?.data?.platforms || {};
  const out = [];
  for (const p of Object.values(platforms)) {
    for (const r of p?.byDimension?.[dimension] || []) out.push(r);
  }
  return out;
};

// Placement breakdown — Facebook vs Instagram vs Audience Network (the
// reference Meta audit's Section 6). Account-level dimension totals, so when a
// tracking-anomaly campaign exists its fake conversions are inside these rows —
// a too-cheap placement inherits the tracking caveat instead of a "scale this"
// badge (the never-confidently-wrong rule).
const placementBreakdownSection = (audit, currency, totals) => {
  const recs = dimensionRecords(audit, "placement");
  if (recs.length < 2) return null;
  const { baselineCpa, anomalyNames } = accountBaseline(audit, totals);
  const totalSpend = num(totals.spend);
  const rows = recs
    .map((r) => ({
      placement: cleanSegmentValue(r.segment || r.placement || "—"),
      spend: num(r.spend),
      conv: num(r.conversions ?? r.results),
      clicks: num(r.clicks),
      impressions: num(r.impressions),
    }))
    .filter((r) => r.spend > 0 && (r.conv >= 3 || r.spend >= totalSpend * 0.005))
    .sort((a, b) => b.spend - a.spend)
    .slice(0, MAX_DIM_ROWS);
  if (rows.length < 2) return null;

  const tableRows = rows.map((r) => {
    const cpa = r.conv > 0 ? r.spend / r.conv : null;
    const cpm = r.impressions > 0 ? (r.spend / r.impressions) * 1000 : null;
    const share = totalSpend > 0 ? (r.spend / totalSpend) * 100 : 0;
    let note = "On baseline";
    if (r.conv === 0) note = "Zero conversions";
    else if (baselineCpa && cpa != null && cpa < baselineCpa * 0.35 && anomalyNames.size > 0) {
      note = "Unverified — includes the flagged campaign";
    } else if (baselineCpa && cpa != null && cpa >= baselineCpa * 2) note = `${(cpa / baselineCpa).toFixed(1)}× baseline`;
    else if (baselineCpa && cpa != null && cpa <= baselineCpa * 0.75) note = "Beats baseline";
    return [
      r.placement,
      formatMoney(r.spend, currency),
      `${share.toFixed(1)}%`,
      String(Math.round(r.conv)),
      cpaCell(r.spend, r.conv, currency),
      cpm != null ? formatMoney(cpm, currency) : "—",
      note,
    ];
  });

  return {
    id: "placement-breakdown",
    eyebrow: "Placement",
    title: "Where the spend serves, by platform",
    intro: "Spend, results, and cost per result by placement platform. A placement paying a large CPM premium while converting worse than the account average is the first exclusion candidate.",
    blocks: [
      {
        type: "data_table",
        columns: [
          { header: "Placement", align: "left" },
          { header: "Spend", align: "right", width: "92px" },
          { header: "Share", align: "right", width: "60px" },
          { header: "Results", align: "right", width: "64px" },
          { header: "Cost / result", align: "right", width: "96px" },
          { header: "CPM", align: "right", width: "80px" },
          { header: "Note", align: "left", width: "128px" },
        ],
        currency,
        rows: tableRows,
        footnote:
          "Account-level placement totals." +
          (anomalyNames.size > 0
            ? " The campaign with unverified conversions is included in these rows — an implausibly cheap placement here carries its tracking caveat, not a scale recommendation."
            : ""),
      },
    ],
  };
};

// Ad-set breakdown — per-campaign ad set comparison (the reference Meta audit's
// Section 5: broad vs interest CPL per campaign, and the account's best ad
// set). Skipped for Google, whose ad groups are covered by the keyword/audience
// grain and typically carry default names.
const adSetBreakdownSection = (audit, currency, totals) => {
  const platforms = audit.normalizedDataset?.data?.platforms || {};
  const recs = [];
  for (const [key, p] of Object.entries(platforms)) {
    if (key === "GOOGLE") continue;
    for (const r of p?.byLevel?.adset || []) recs.push(r);
  }
  if (recs.length < 2) return null;
  const { baselineCpa, anomalyNames } = accountBaseline(audit, totals);
  const totalSpend = num(totals.spend);
  const rows = recs
    .map((r) => ({
      campaign: r.campaignName || "—",
      adSet: r.name || "—",
      spend: num(r.spend),
      conv: num(r.results ?? r.conversions),
      freq: num(r.frequency),
      anomaly: anomalyNames.has(normName(r.campaignName)),
    }))
    .filter((r) => r.spend > 0 && (r.conv >= 3 || r.spend >= totalSpend * 0.005))
    .sort((a, b) => b.spend - a.spend)
    .slice(0, MAX_DIM_ROWS);
  if (rows.length < 2) return null;

  // The single best ad set on real volume — the reference's "should not be
  // touched" callout — judged only on trusted (non-anomaly) rows.
  const best = rows
    .filter((r) => !r.anomaly && r.conv >= 20)
    .reduce((acc, r) => {
      const cpa = r.spend / r.conv;
      return acc == null || cpa < acc.cpa ? { ...r, cpa } : acc;
    }, null);

  const tableRows = rows.map((r) => {
    const cpa = r.conv > 0 ? r.spend / r.conv : null;
    let note = "On baseline";
    if (r.anomaly) note = "Unverified — see tracking finding";
    else if (r.conv === 0) note = "Zero conversions";
    else if (best && r.campaign === best.campaign && r.adSet === best.adSet) note = "Best ad set — protect";
    else if (baselineCpa && cpa != null && cpa >= baselineCpa * 2) note = `${(cpa / baselineCpa).toFixed(1)}× baseline`;
    else if (baselineCpa && cpa != null && cpa <= baselineCpa * 0.75) note = "Beats baseline";
    else if (r.freq >= 2.5) note = `Frequency ${r.freq.toFixed(1)}× — fatiguing`;
    return [
      r.campaign,
      r.adSet,
      formatMoney(r.spend, currency),
      String(Math.round(r.conv)),
      cpaCell(r.spend, r.conv, currency),
      r.freq > 0 ? `${r.freq.toFixed(2)}×` : "—",
      note,
    ];
  });

  return {
    id: "adset-breakdown",
    eyebrow: "Ad sets",
    title: "Inside each campaign: the ad sets",
    intro: "Each spending ad set's cost per result and frequency. The same audience split performing differently across campaigns tells you which targeting layer earns its budget — and which ad set to protect.",
    blocks: [
      {
        type: "data_table",
        columns: [
          { header: "Campaign", align: "left" },
          { header: "Ad set", align: "left", width: "110px" },
          { header: "Spend", align: "right", width: "92px" },
          { header: "Results", align: "right", width: "64px" },
          { header: "Cost / result", align: "right", width: "96px" },
          { header: "Freq", align: "right", width: "56px" },
          { header: "Note", align: "left", width: "140px" },
        ],
        currency,
        rows: tableRows,
        footnote: "Frequency above ~2.5× over the window means the audience is seeing the same ads repeatedly — expect CPM inflation until the pool is refreshed.",
      },
    ],
  };
};

// Audience-by-segment — the reference's Section 4.1: the SAME segment id across
// campaigns/markets, with CVR and cost per result, proving misapplication.
const audienceSegmentSection = (audit, currency) => {
  const recs = recordsAtLevel(audit, "audience_performance");
  if (recs.length < 2) return null;
  const rows = recs
    .map((r) => ({
      // Prefer the audience's human name; fall back to the raw criterion id
      // wrapped as a label so the renderer can't reformat it as a number
      // ("2,488,177,887,755").
      segment:
        r.audienceLabel || r.audienceName || r.segment ||
        (r.criterionId || r.audienceId ? `Segment ${r.criterionId || r.audienceId}` : "—"),
      campaign: r.campaignName || r.adGroupName || "—",
      spend: num(r.spend),
      clicks: num(r.clicks),
      conv: num(r.conversions ?? r.results),
    }))
    // A segment with a handful of clicks has no readable CVR — keep zero-result
    // rows only when the click sample is at least double digits.
    .filter((r) => (r.spend > 0 || r.clicks > 0) && (r.conv > 0 || r.clicks >= 10))
    .sort((a, b) => b.spend - a.spend)
    .slice(0, MAX_DIM_ROWS);
  if (rows.length < 2) return null;
  const tableRows = rows.map((r) => [
    String(r.segment),
    r.campaign,
    String(Math.round(r.clicks)),
    String(Math.round(r.conv)),
    pctCell(r.conv, r.clicks),
    cpaCell(r.spend, r.conv, currency),
  ]);
  return {
    id: "audience-segments",
    eyebrow: "Audience",
    title: "The same audience, campaign by campaign",
    intro: "Conversion rate and cost per result for each audience segment. When one segment id converts well in one campaign and collapses in another, the audience is mis-applied — not the creative.",
    blocks: [
      {
        type: "data_table",
        columns: [
          { header: "Segment", align: "left" },
          { header: "Campaign", align: "left" },
          { header: "Clicks", align: "right", width: "72px" },
          { header: "Results", align: "right", width: "70px" },
          { header: "CVR", align: "right", width: "72px" },
          { header: "Cost / result", align: "right", width: "104px" },
        ],
        currency,
        rows: tableRows,
        footnote: "CVR = conversions ÷ clicks. A strong CVR in one campaign and a weak one in another on the same segment points to misapplication.",
      },
    ],
  };
};

// Funnel / destination — the core "is it the ad or the funnel?" table. Per
// campaign: the CVR needed to hit target (CPC ÷ target CPA) vs the actual CVR.
// A healthy CTR but an actual CVR far below required localizes the loss DOWNSTREAM
// of the click (offer / landing page / funnel), per market — the reference's
// Section 8. Needs a target CPA (declared or inferred).
const funnelCvrSection = (audit, currency, totals) => {
  const platform = audit.selectedPlatforms?.[0] || "GOOGLE";
  const sectionA = audit.businessProfileSnapshot?.sectionA || {};
  const declared = num(sectionA.targetCpa);
  const inferred = num(audit.normalizedDataset?.summary?.platforms?.[platform]?.inferredTargetCpa);
  const target = declared > 0 ? declared : inferred;
  if (!(target > 0)) return null;

  // Only campaigns with a real click sample belong in a CVR comparison — a
  // 5-to-8-click test campaign gives a meaningless CVR (5 conv / 8 clicks = 62%)
  // and produces noise rows. Require a minimum click volume.
  // Anomaly campaigns (conversions too cheap to be genuine) are excluded
  // entirely: their fake CVR would (a) render as the table's only "funnel
  // success", contradicting the tracking finding, and (b) their fake-cheap CPA
  // would defeat the achievable-target override below, scoring every REAL
  // campaign against an impossible bar.
  const { anomalyNames: funnelAnomalies } = accountBaseline(audit, totals);
  const campaigns = recordsAtLevel(audit, "campaign").filter(
    (c) =>
      num(c.spend) > 0 &&
      num(c.clicks) >= MIN_FUNNEL_CLICKS &&
      !funnelAnomalies.has(normName(c.name))
  );
  if (campaigns.length < 1) return null;

  // The funnel must never require a CVR that even the MOST EFFICIENT campaign
  // can't hit. When the declared target is below every campaign's achieved cost
  // per result (an unrealistic target — e.g. a PKR 40 target on an account whose
  // best campaign runs at PKR 84), measuring "CVR needed" against it brands EVERY
  // campaign — including the proven winner — "downstream", which flatly
  // contradicts the lead ("re-enable this winner"). So measure against the
  // achievable floor: max(target, best achieved CPA).
  // The achievable bar needs PROVEN volume (≥20 conversions) — a 15-conversion
  // side campaign's PKR 94 must not set a stricter bar than the PKR 104 the
  // cards and scorecard use. Fall back to any converting campaign only when
  // nothing has real volume.
  const cpaOfCampaign = (c) => {
    const conv = num(c.results ?? c.conversions);
    return conv > 0 ? { cpa: num(c.spend) / conv, conv } : null;
  };
  const achieved = campaigns.map(cpaOfCampaign).filter((v) => v != null && v.cpa > 0);
  const proven = achieved.filter((v) => v.conv >= 20);
  const pool = proven.length ? proven : achieved;
  const bestCpa = pool.length ? Math.min(...pool.map((v) => v.cpa)) : null;
  const effectiveTarget = bestCpa != null ? Math.max(target, bestCpa) : target;
  const targetOverridden = bestCpa != null && bestCpa > target;

  const rows = campaigns
    .map((c) => {
      const spend = num(c.spend);
      const clicks = num(c.clicks);
      const conv = num(c.results ?? c.conversions);
      const cpc = clicks > 0 ? spend / clicks : null;
      const requiredCvr = cpc != null && effectiveTarget > 0 ? cpc / effectiveTarget : null; // CPC / achievable CPA
      const actualCvr = clicks > 0 ? conv / clicks : null;
      return { name: c.name || "—", cpc, requiredCvr, actualCvr };
    })
    // Exclude campaigns whose required CVR exceeds 100%: when CPC ≥ target CPA, no
    // conversion rate can hit the target, so it's a CPC/bidding ceiling, not a
    // funnel/landing-page gap — labeling it "downstream" would point at the wrong
    // lever (surfaced e.g. "CVR needed 830%" on a PKR 332-CPC test campaign).
    .filter((r) => r.cpc != null && r.requiredCvr != null && r.requiredCvr <= 1 && r.actualCvr != null)
    .sort((a, b) => a.actualCvr / a.requiredCvr - b.actualCvr / b.requiredCvr)
    .slice(0, MAX_DIM_ROWS);
  if (rows.length < 1) return null;

  let anyDownstream = false;
  const tableRows = rows.map((r) => {
    const ratio = r.requiredCvr > 0 ? r.actualCvr / r.requiredCvr : 1;
    let verdict = "Funnel converts";
    if (ratio < 0.5) { verdict = `${(1 / Math.max(ratio, 0.001)).toFixed(1)}× short — downstream`; anyDownstream = true; }
    else if (ratio < 0.9) { verdict = "Below required — check funnel"; anyDownstream = true; }
    else if (ratio >= 1) verdict = "Meets/beats required";
    return [
      r.name,
      // CPC is a small value where whole-currency rounding loses meaning
      // (PKR 2.56 → "PKR 3"), so show two decimals here specifically.
      `${String(currency || "USD").toUpperCase()} ${r.cpc.toFixed(2)}`,
      `${(r.requiredCvr * 100).toFixed(2)}%`,
      `${(r.actualCvr * 100).toFixed(2)}%`,
      verdict,
    ];
  });

  const targetPhrase = targetOverridden
    ? `an achievable ${formatMoney(effectiveTarget, currency)} cost per result — your ${formatMoney(target, currency)} target is below every campaign's achieved cost per result, so the funnel is measured against the most efficient campaign, not an unreachable target`
    : `the ${formatMoney(target, currency)} target`;
  const intro = anyDownstream
    ? `The conversion rate each campaign needs to hit ${targetPhrase}, versus what it actually gets. Where clicks are healthy but the actual CVR is far below required, the loss is downstream of the click — the offer, landing page, or funnel — not the ad or the bid. If the same offer converts in one market and collapses in another, the barrier is structural to that market.`
    : `The conversion rate each campaign needs to hit ${targetPhrase}, versus what it actually gets. Every campaign is at or near the required rate — the funnel is converting.`;

  return {
    id: "funnel-cvr",
    eyebrow: "Funnel / destination",
    title: "Is the gap in the ad, or downstream?",
    intro,
    blocks: [
      {
        type: "data_table",
        columns: [
          { header: "Campaign", align: "left" },
          { header: "CPC", align: "right", width: "84px" },
          { header: "CVR needed", align: "right", width: "96px" },
          { header: "Actual CVR", align: "right", width: "92px" },
          { header: "Verdict", align: "left" },
        ],
        currency,
        rows: tableRows,
        footnote:
          "CVR needed = CPC ÷ target CPA. A healthy CTR with an actual CVR far below the required rate points downstream (landing page / offer / tracking), not to the ads." +
          (funnelAnomalies.size > 0
            ? " The campaign whose conversions are too cheap to be genuine is excluded — its conversion rate cannot be trusted (see the tracking-integrity finding)."
            : ""),
      },
    ],
  };
};

// Opportunities & account hygiene — the forward-looking "what to build / clean
// up next" section, separated from the problems so the report isn't a pure
// complaint sheet (the reference's Governance / Market-coverage sections). Built
// ONLY from opportunity/hygiene findings the engine actually detected — never
// from an assumed-absent best practice we can't verify from the data.
const OPPORTUNITY_RX = /^(OPP|GOOGLE-HYGIENE|GOOGLE-EXT|META-HYGIENE|COMP-OPP)/;
const opportunitiesSection = (findings, currency) => {
  const opps = findings.filter((f) => OPPORTUNITY_RX.test(f.ruleId || ""));
  if (opps.length < 1) return null;
  const rows = opps.slice(0, 8).map((f) => {
    const move =
      (Array.isArray(f.fixSteps) && f.fixSteps[0]) ||
      f.estimatedImpact ||
      "Review and action this in the platform.";
    // Name concrete examples when the engine collected them ("26 idle campaigns"
    // means little; naming three makes it checkable in the platform).
    const examples = Array.isArray(f.evidence?.examples)
      ? f.evidence.examples.filter(Boolean).slice(0, 3)
      : [];
    const exampleNote = examples.length ? ` E.g. ${examples.map((n) => `"${n}"`).join(", ")}.` : "";
    return [f.title, `${cleanReportText(String(move)).slice(0, 160)}${exampleNote}`];
  });
  return {
    id: "opportunities",
    eyebrow: "Opportunities & hygiene",
    title: "Growth levers and cleanup, beyond the fixes",
    intro: "Forward-looking moves and account hygiene the engine detected — the build-and-clean-up work that compounds once the urgent leaks are fixed. Only items grounded in the account data appear here.",
    blocks: [
      {
        type: "data_table",
        columns: [
          { header: "Opportunity", align: "left" },
          { header: "First move", align: "left" },
        ],
        currency,
        rows,
        footnote: "These are growth/hygiene levers, not measured leaks — sequenced after the recoverable-spend fixes.",
      },
    ],
  };
};

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
  // Pull ALL campaigns (active + paused); the report shows the total and splits it
  // active vs paused. Headline = total; the comparison focuses on the active set.
  const scope = getCampaignScope(audit);
  const campaignNames = collectCampaignNames(audit);
  const findings = sortFindingsForReport(audit.ruleFindings || []);
  if (!findings.length) return noFindingsDocument({ audit, currency, totals });

  // The headline must be a finding that stands on its own. A "secondary" finding
  // is an overlap lens ("the placement view of inefficiency the campaign finding
  // already counts") reframed to net PKR 0 — it must never lead the report, or
  // the cover announces a number that recovers nothing. Lead with the first
  // primary finding instead; fall back only if every finding is secondary.
  const isSecondaryLens = (f) => f.evidence?.trust?.role === "secondary";
  // When the source data is physically impossible (clicks > impressions, …) every
  // cost figure is untrustworthy, so the data-integrity warning LEADS and the
  // report quantifies nothing — a confident dollar number on garbage input is the
  // worst outcome. Otherwise lead with the first finding that stands on its own.
  const integrityFinding = findings.find((f) => f.evidence?.dataIntegrityBroken === true);
  const top = integrityFinding || findings.find((f) => !isSecondaryLens(f)) || findings[0];
  const topMoney = integrityFinding ? 0 : moneyMagnitude(top.estimatedImpact || top.evidence);
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
    f.evidence?.advisory !== true &&
    findingRecoverable(f) > 0;
  // Broken integrity → quantify nothing (no money map, no recoverable headline).
  const quantified = integrityFinding ? [] : findings.filter(isRecoverableWaste);
  // Overlap-aware total: the same wasted spend surfaces as several findings
  // (campaign + audience + device + geo on one campaign). Count each dollar once
  // instead of summing — naive summing inflates the headline 2-3×.
  const { total: recoverable } = integrityFinding ? { total: 0 } : reconcileRecoverable(
    findings.filter(
      (f) =>
        f.evidence?.blocksDelivery !== true &&
        f.evidence?.diagnostic !== true &&
        f.evidence?.advisory !== true
    ),
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

  // Active vs paused split — discloses how the headline total divides between live
  // and paused campaigns. Only rendered when both cohorts have spend.
  const scopeBreakdown = scopeBreakdownSection(scope, currency);
  if (scopeBreakdown) sections.push(scopeBreakdown);

  // What's working — measured strengths before the problem inventory, so the
  // report reads like a review, not a complaint sheet.
  const working = whatsWorkingSection(audit, currency, totals, findings);
  if (working) sections.push(working);

  if (quantified.length > 0) {
    const maxImpact = Math.max(
      ...quantified.map((f) => findingRecoverable(f)),
      1
    );
    const shown = quantified.slice(0, 6);
    const shownSum = shown.reduce((s, f) => s + findingRecoverable(f), 0);
    const sumsToHeadline = recoverable > 0 && Math.abs(shownSum - recoverable) <= Math.max(1, recoverable * 0.01);
    sections.push({
      id: "money-map",
      eyebrow: "Money map",
      title: "Where the recoverable spend is concentrated",
      intro: "Only findings with measured financial evidence appear here. Structural risks stay out of this chart unless the engine can quantify them.",
      blocks: [
        {
          type: "bar_chart_h",
          rows: shown.map((f) => {
            const value = findingRecoverable(f);
            return {
              label: netAdjustedText(f.title, f, currency),
              value,
              max: maxImpact,
              tone: f === top ? "warn" : "brand",
              display: formatMoney(value, currency),
            };
          }),
          currency,
          gridlines: true,
          caption: sumsToHeadline
            ? `Overlap-adjusted recoverable spend by finding — the amounts sum to the ${formatMoney(recoverable, currency)} headline total.`
            : `Overlap-adjusted recoverable spend by finding (top ${shown.length} of ${quantified.length} quantified findings).`,
        },
      ],
    });
  }

  // Show every finding in the index, not a truncated subset — a table that said
  // "10 findings" while listing 8 broke trust in the count. Capped only as a
  // runaway guard; the title stays honest about what's shown when that hits.
  const FINDINGS_TABLE_MAX = 15;
  const shownFindings = findings.slice(0, FINDINGS_TABLE_MAX);
  const findingsTitle =
    findings.length > FINDINGS_TABLE_MAX
      ? `Top ${FINDINGS_TABLE_MAX} of ${findings.length} findings, ranked by impact`
      : `${findings.length} findings, ranked by impact`;

  sections.push({
    id: "findings",
    eyebrow: "Findings",
    title: findingsTitle,
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
        rows: shownFindings.map((f, i) => [
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
  const deepDive = campaignDeepDiveSection(audit, currency, totals, scope);
  if (deepDive) sections.push(deepDive);

  // Per-campaign scored cards (CTR vs benchmark, CPA vs target) — the strategist
  // view, after the overview table.
  const campaignCards = campaignCardsSection(audit, currency, totals, scope);
  if (campaignCards) sections.push(campaignCards);

  // Dimensional breakdowns — the owned per-dimension sections a senior audit
  // presents (geo, device, audience, funnel). Each is null when its grain wasn't
  // pulled, so a summary-only or thin account simply omits it.
  const funnel = funnelCvrSection(audit, currency, totals);
  if (funnel) sections.push(funnel);
  const geoBreak = geoBreakdownSection(audit, currency, totals);
  if (geoBreak) sections.push(geoBreak);
  const placementBreak = placementBreakdownSection(audit, currency, totals);
  if (placementBreak) sections.push(placementBreak);
  const deviceBreak = deviceBreakdownSection(audit, currency, totals);
  if (deviceBreak) sections.push(deviceBreak);
  const adSetBreak = adSetBreakdownSection(audit, currency, totals);
  if (adSetBreak) sections.push(adSetBreak);
  const audienceSeg = audienceSegmentSection(audit, currency);
  if (audienceSeg) sections.push(audienceSeg);

  // Creative & copy — data-grounded ad copy / creative / extension suggestions.
  const creative = creativeSection(audit, findings, currency);
  if (creative) sections.push(creative);

  sections.push({
    id: "finding-detail",
    // Every finding that claims money (or blocks delivery) gets a full evidence
    // card — a "wasting PKR 4,094" row in the table with no card to explain the
    // baseline math is exactly the unexplained-finding complaint. Top 6 by
    // leverage always render; money findings beyond that are appended (cap 10).
    eyebrow: "Evidence",
    title: "The evidence, finding by finding",
    intro: "Each finding shows what is happening, the business impact, supporting evidence, confidence, and the recommended fix.",
    blocks: findings
      .filter((finding, index) => index < 6 || findingRecoverable(finding) > 0 || finding.evidence?.blocksDelivery === true)
      .slice(0, 10)
      .map((finding) => findingBlock(finding, currency, campaignNames)),
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

  // Opportunities & hygiene — forward-looking growth/cleanup levers, framed
  // separately from the problems so the report isn't a pure complaint sheet.
  const opportunities = opportunitiesSection(findings, currency);
  if (opportunities) sections.push(opportunities);

  // Phased strategic roadmap — sits after the evidence/benchmarks, before the
  // week-one action checklist renders.
  const roadmap = roadmapSection(findings, currency);
  if (roadmap) sections.push(roadmap);

  // Project the RECONCILED recoverable total — the same figure as the
  // "Recoverable this period" key number — never `topMoney`. topMoney is scraped
  // from the lead finding's narrative; when that finding is diagnostic (a
  // tracking anomaly whose text cites the PKR 115 baseline) it would project the
  // baseline CPA as if it were recoverable money, inventing a quarterly/annual
  // "opportunity" that recovers nothing. No recoverable spend → no projection.
  const projection = recoverable > 0
    ? {
        period_value: recoverable,
        quarterly: recoverable * 3,
        annualized: recoverable * 12,
        disclaimer: "Projection multiplies the recoverable spend measured this period and assumes spend and performance patterns remain stable.",
      }
    : undefined;

  // Truncate at a word boundary — a hard slice cut headlines mid-word
  // ("…too cheap to be genuine — like").
  const truncateHeadline = (text, max = 100) => {
    const s = String(text || "");
    if (s.length <= max) return s;
    const cut = s.slice(0, max - 1);
    const atWord = cut.slice(0, cut.lastIndexOf(" "));
    return `${atWord || cut}…`;
  };

  return {
    masthead: {
      headline: integrityFinding || topMoney > 0 ? truncateHeadline(netAdjustedText(top.title, top, currency)) : `${platformLabel} needs cleanup`,
      subline: integrityFinding
        ? top.detail
        : topMoney > 0
          ? netAdjustedText(top.estimatedImpact, top, currency)
          : "The largest risks are structural and not safely quantifiable from available data.",
      prepared_for: audit.organization?.name || audit.adAccount?.name || null,
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
        ? `The single most important finding in this audit: ${netAdjustedText(top.estimatedImpact, top, currency)}`
        : `The biggest issue is ${top.title}. It is a business risk, but the available data does not support a reliable money estimate.`,
      paragraphs: [
        // Root-cause synthesis leads when the account has a binding constraint
        // (a policy block or a geo misconfiguration), framing the real story
        // before the lead-issue restatement.
        ...(rootCauseSynthesis(findings) ? [rootCauseSynthesis(findings)] : []),
        `**Lead issue:** ${netAdjustedText(top.title, top, currency)}. ${emphasizeCampaignNames(netAdjustedText(top.detail, top, currency), campaignNames) || top.estimatedImpact || "This is the highest-priority finding in the account data."}`,
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
        action: `**${netAdjustedText(f.title, f, currency)}:** ${(Array.isArray(f.fixSteps) && f.fixSteps[0]) || "Apply the recommended fix in the platform."}`,
        effort: findingEase(f) === "easy" ? "~1 hour" : findingEase(f) === "medium" ? "Half day" : "Technical",
        result: impactLabel(f, currency),
        result_tone: moneyMagnitude(f.estimatedImpact) > 0 ? "good" : "neutral",
        links_to_finding: f.ruleId,
      })),
    },
    method_notes: [
      { label: "Numbers", text: "Every figure comes from verified account data. The report does not invent chart values." },
      ...(recoverable > 0
        ? [{
            label: "Money figures",
            text: `Each finding shows the spend recoverable by that single fix. Where several findings describe the same wasted spend from different angles (campaign, audience, device, geography), it is counted once — those findings are labeled "same spend (counted above)". The headline "Recoverable this period" (${formatMoney(recoverable, currency)}) is the sum of the overlap-adjusted amounts, so the finding figures add up to it exactly.`,
          }]
        : []),
      ...(scope.hasPaused && scope.hasActive
        ? [{
            label: "Scope",
            text: `Figures cover all ${scope.active.length + scope.paused.length} campaigns that spent this period. The Active vs Paused breakdown splits the total: ${formatMoney(scope.activeTotals.spend, currency)} from ${scope.active.length} active campaign${scope.active.length === 1 ? "" : "s"} and ${formatMoney(scope.pausedTotals.spend, currency)} from ${scope.paused.length} paused. The per-campaign comparison and recommendations focus on the active set, which is what can still be optimised.`,
          }]
        : !scope.hasActive && scope.hasPaused
          ? [{ label: "Scope", text: "The campaigns that spent this period are now paused — none is currently delivering, so there is no live set to isolate. The figures cover all of them; the recommendations are about what to re-enable or restructure, not a live budget to optimise." }]
          : []),
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
