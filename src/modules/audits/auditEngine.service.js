import {
  analyzeDimension,
  baselineCpa,
} from "../../lib/segments/contributionAnalysis.js";
import {
  buildCohortBaselines,
  cohortBaselineFor,
  cohortKeyOf,
  cohortLabel,
} from "../../lib/segments/cohortBaseline.js";
import {
  gateFinding,
  zeroConversionConfident,
  wilsonInterval,
} from "../../lib/stats/significance.js";
import { diagnoseCpaDriver } from "../../lib/kpi/decomposition.js";
import { byLeverageDesc } from "../../lib/findings/priority.js";
import { collapseOverlappingFindings } from "../../lib/findings/dedupe.js";
import { applyTrustLayer } from "../../lib/findings/trustLayer.js";
import {
  detectConversionAnomalies,
  normName,
} from "../../lib/findings/conversionAnomaly.js";
import { reconcileCampaignResultsFromAdSets } from "../../lib/normalize/metaResultReconcile.js";

const SEVERITY_PENALTIES = {
  CRITICAL: 25,
  HIGH: 15,
  MEDIUM: 8,
  LOW: 3,
};

const PLATFORM_CATEGORIES = {
  META: {
    "Tracking & Pixel Health": 20,
    "Campaign Structure": 20,
    "Audience Strategy": 20,
    "Creative Performance": 15,
    "Bidding & Budget": 15,
    "Retargeting Coverage": 10,
    "Attribution & Reporting": 10,
  },
  GOOGLE: {
    "Conversion Tracking Setup": 20,
    "Campaign Structure": 18,
    "Keyword Strategy": 18,
    "Bidding Strategy Alignment": 15,
    "Ad Copy & Extensions": 12,
    "Quality Score & Relevance": 10,
    "Audience & Attribution": 7,
  },
  TIKTOK: {
    "Pixel & Tracking Health": 22,
    "Creative Performance": 25,
    "Campaign Structure": 18,
    "Audience Strategy": 15,
    "Bidding & Budget": 12,
    "Attribution & Reporting": 8,
  },
};

const PLATFORM_LABELS = {
  META: "Meta",
  GOOGLE: "Google",
  TIKTOK: "TikTok",
};

// Industry benchmark thresholds — calibrated 2026-07-01 against published 2025/26
// data (WordStream/LocaliQ Google Ads Benchmarks 2025–2026; WordStream/Triple
// Whale/Lebesgue Meta Ads Benchmarks 2025). Anchors used:
//   • Google SEARCH: avg CTR ~6.6%, avg CPC ~$5.4, avg CVR ~7.5%.
//   • Meta: median CTR 2.19%, median CPM $13.48, median CVR 1.57% (lead ads ~7.7%).
// CAUTION baked in: the Google figures are SEARCH-network averages, but Display
// campaigns run structurally lower CTR (~0.4–0.6% is normal). So Google `good` is
// set toward Search reality while `danger` is kept LOW — a low-CTR Display account
// must not be branded "critically below benchmark" against a Search bar (the same
// invalid-comparison class as the CPM-currency guard). CTR is a ratio (currency-
// independent); CPM thresholds are USD (gated to USD accounts at the call site).
export const INDUSTRY_BENCHMARKS = {
  ctr: {
    META: {
      // median all-industry CTR ~2.19%; fashion/home-decor ~2.8%, B2B lower ~1%.
      eCommerce:     { good: 2.2, warning: 1.1, danger: 0.5 },
      "Lead Gen":    { good: 1.6, warning: 0.8, danger: 0.4 },
      "App Install": { good: 2.0, warning: 1.0, danger: 0.5 },
      Local:         { good: 1.5, warning: 0.8, danger: 0.4 },
      "B2B SaaS":    { good: 1.0, warning: 0.5, danger: 0.25 },
      Other:         { good: 1.6, warning: 0.8, danger: 0.4 },
    },
    GOOGLE: {
      // Search avg ~6.6%; `good` toward Search reality, `danger` kept low so a
      // low-CTR Display account isn't falsely flagged against a Search benchmark.
      eCommerce:     { good: 6.0, warning: 2.0, danger: 0.5 },
      "Lead Gen":    { good: 6.0, warning: 2.0, danger: 0.5 },
      "App Install": { good: 4.5, warning: 1.5, danger: 0.4 },
      Local:         { good: 7.0, warning: 2.5, danger: 0.6 },
      "B2B SaaS":    { good: 5.0, warning: 1.8, danger: 0.4 },
      Other:         { good: 6.0, warning: 2.0, danger: 0.5 },
    },
    TIKTOK: {
      // TikTok CTR runs ~0.8–1.5%; less authoritative public data → conservative.
      eCommerce:     { good: 1.5, warning: 0.7, danger: 0.3 },
      "Lead Gen":    { good: 1.2, warning: 0.6, danger: 0.25 },
      "App Install": { good: 2.0, warning: 1.0, danger: 0.4 },
      Local:         { good: 1.0, warning: 0.5, danger: 0.2 },
      "B2B SaaS":    { good: 0.8, warning: 0.4, danger: 0.2 },
      Other:         { good: 1.0, warning: 0.5, danger: 0.2 },
    },
  },
  cpm: {
    META: {
      // median CPM ~$13.48 (2025, +20% YoY); B2B/retargeting carry premiums.
      eCommerce:     { good: 14, warning: 26, danger: 42 },
      "Lead Gen":    { good: 13, warning: 24, danger: 40 },
      "App Install": { good: 11, warning: 20, danger: 34 },
      Local:         { good: 10, warning: 20, danger: 32 },
      "B2B SaaS":    { good: 20, warning: 38, danger: 60 },
      Other:         { good: 13, warning: 25, danger: 40 },
    },
    TIKTOK: {
      // TikTok CPM runs below Meta; ~$6–12 typical.
      eCommerce:     { good: 8,  warning: 18, danger: 30 },
      "Lead Gen":    { good: 7,  warning: 15, danger: 25 },
      "App Install": { good: 6,  warning: 14, danger: 22 },
      Local:         { good: 5,  warning: 12, danger: 20 },
      "B2B SaaS":    { good: 10, warning: 20, danger: 35 },
      Other:         { good: 7,  warning: 15, danger: 25 },
    },
  },
  // Conversion-rate benchmarks (%) — real 2025 medians. NOT yet wired to a firing
  // rule (exposed via getBenchmark for the scorecard / future CVR verdicts); CVR
  // is highly objective-dependent, so these are directional context, not a hard
  // gate. Google = Search CVR (~7.5% avg); Meta = median 1.57%, lead ads ~7.7%.
  cvr: {
    GOOGLE: {
      eCommerce:     { good: 3.5, warning: 2.0, danger: 1.0 },
      "Lead Gen":    { good: 7.0, warning: 3.5, danger: 1.5 },
      "App Install": { good: 4.0, warning: 2.0, danger: 1.0 },
      Local:         { good: 6.0, warning: 3.0, danger: 1.2 },
      "B2B SaaS":    { good: 4.0, warning: 2.0, danger: 1.0 },
      Other:         { good: 5.0, warning: 2.5, danger: 1.2 },
    },
    META: {
      eCommerce:     { good: 2.0, warning: 1.0, danger: 0.5 },
      "Lead Gen":    { good: 5.0, warning: 2.5, danger: 1.0 },
      "App Install": { good: 3.0, warning: 1.5, danger: 0.7 },
      Local:         { good: 3.0, warning: 1.5, danger: 0.7 },
      "B2B SaaS":    { good: 2.0, warning: 1.0, danger: 0.5 },
      Other:         { good: 2.5, warning: 1.2, danger: 0.6 },
    },
    TIKTOK: {
      eCommerce:     { good: 1.5, warning: 0.8, danger: 0.4 },
      "Lead Gen":    { good: 3.0, warning: 1.5, danger: 0.7 },
      "App Install": { good: 2.0, warning: 1.0, danger: 0.5 },
      Local:         { good: 2.0, warning: 1.0, danger: 0.5 },
      "B2B SaaS":    { good: 1.5, warning: 0.8, danger: 0.4 },
      Other:         { good: 2.0, warning: 1.0, danger: 0.5 },
    },
  },
};

// Google NETWORK benchmarks — network dominates CTR/CVR/CPM far more than
// business type (Search avg CTR ~6.6% vs Display ~0.5% — a ~13× gap; business-type
// variation within a network is ~2×). The business-type GOOGLE table above is
// calibrated to SEARCH; these bands cover the other networks so a Display / Video /
// Shopping / PMax account is judged against its OWN network's norms, never a Search
// bar. Published 2025/26 network averages (Google/WordStream/industry): Display CTR
// ~0.5% & CVR ~0.7%; Shopping CTR ~0.85% & CVR ~1.9%; Video CTR ~0.5%; PMax blended
// ~1–2% CTR / ~3% CVR. CPM is only meaningful for the impression-bought networks
// (Display/Video). Bands: CTR/CVR descend (higher better); CPM ascends (lower better).
export const GOOGLE_NETWORK_BENCHMARKS = {
  SEARCH:     { ctr: { good: 6.0, warning: 2.0, danger: 0.5 },  cvr: { good: 7.0, warning: 3.0, danger: 1.2 } },
  DISPLAY:    { ctr: { good: 0.6, warning: 0.35, danger: 0.15 }, cvr: { good: 0.7, warning: 0.35, danger: 0.15 }, cpm: { good: 4, warning: 9, danger: 16 } },
  SHOPPING:   { ctr: { good: 0.9, warning: 0.5, danger: 0.25 }, cvr: { good: 1.9, warning: 1.0, danger: 0.4 } },
  VIDEO:      { ctr: { good: 0.6, warning: 0.3, danger: 0.15 }, cvr: { good: 0.6, warning: 0.3, danger: 0.12 }, cpm: { good: 12, warning: 22, danger: 35 } },
  PMAX:       { ctr: { good: 1.2, warning: 0.6, danger: 0.3 },  cvr: { good: 3.0, warning: 1.5, danger: 0.7 } },
  DEMAND_GEN: { ctr: { good: 0.8, warning: 0.4, danger: 0.2 },  cvr: { good: 1.0, warning: 0.5, danger: 0.2 } },
};

// Google advertisingChannelType (GAQL enum) → our network-benchmark key.
const GOOGLE_CHANNEL_MAP = {
  SEARCH: "SEARCH",
  DISPLAY: "DISPLAY",
  SHOPPING: "SHOPPING",
  VIDEO: "VIDEO",
  PERFORMANCE_MAX: "PMAX",
  DISCOVERY: "DEMAND_GEN",
  DEMAND_GEN: "DEMAND_GEN",
};

/**
 * Look up the good/warning/danger band for a metric. For Google, when the
 * account's dominant NETWORK is known and is NOT Search, prefer the network band
 * (Display/Video/Shopping/PMax) so a low-CTR Display account isn't judged against
 * the Search bar. Search + unknown network fall through to the business-type table
 * (which is Search-calibrated and keeps per-business-type nuance).
 */
export const getBenchmark = (metric, platform, businessType, network = null) => {
  if (platform === "GOOGLE" && network && network !== "SEARCH") {
    const netBand = GOOGLE_NETWORK_BENCHMARKS[network]?.[metric];
    if (netBand) return netBand;
  }
  return (
    INDUSTRY_BENCHMARKS[metric]?.[platform]?.[businessType] ||
    INDUSTRY_BENCHMARKS[metric]?.[platform]?.Other ||
    null
  );
};

// Result/objective signal → business-model bucket. Only the unambiguous mappings
// are inferred; lead/messaging both mean "Lead Gen" (a B2B SaaS account also runs
// lead-gen, so ad data can't distinguish them — we never claim that precision).
const FAMILY_TO_BUSINESS_TYPE = {
  purchase: "eCommerce",
  app_install: "App Install",
  lead: "Lead Gen",
  messaging: "Lead Gen",
  registration: "Lead Gen",
};

/**
 * Infer the business-model bucket from the account's own result mix, weighting
 * each campaign's result family by spend. Returns null when the signal is absent
 * or ambiguous (traffic/awareness only) — the caller then keeps "Other".
 *
 * This is a FALLBACK for audits with no declared business type (common on
 * self-serve OAuth runs), NOT an override: a declared type always wins, because
 * ad data cannot refute a user's stated model (e.g. a B2B SaaS firm legitimately
 * running lead-gen looks identical to generic lead-gen here).
 */
export const inferBusinessType = (dataset) => {
  const platforms = dataset?.data?.platforms || {};
  const spendByType = {};
  for (const p of Object.values(platforms)) {
    for (const c of p?.byLevel?.campaign || p?.records || []) {
      const type = FAMILY_TO_BUSINESS_TYPE[c.resultFamily];
      if (!type) continue;
      spendByType[type] = (spendByType[type] || 0) + (Number(c.spend) || 0);
    }
  }
  let best = null;
  let max = 0;
  for (const [type, spend] of Object.entries(spendByType)) {
    if (spend > max) {
      max = spend;
      best = type;
    }
  }
  return best;
};

/**
 * The business type to score benchmarks against: the user's declared type when
 * present, otherwise inferred from the account data, otherwise "Other".
 * @returns {{ businessType: string, source: 'declared'|'detected'|'default' }}
 */
export const resolveBusinessType = (audit, dataset) => {
  const declared = audit?.businessProfileSnapshot?.sectionA?.businessType;
  if (declared && declared !== "Other") return { businessType: declared, source: "declared" };
  const inferred = inferBusinessType(dataset);
  if (inferred) return { businessType: inferred, source: "detected" };
  return { businessType: "Other", source: "default" };
};

const toArray = (value) => (Array.isArray(value) ? value : value ? [value] : []);

const text = (value) => String(value || "").toLowerCase();

const includesAny = (value, terms) => {
  const values = toArray(value).map(text);
  return terms.some((term) => values.some((valueItem) => valueItem.includes(term)));
};

// Word-boundary match — prevents "Do not know".includes("no") false positives.
// Use this instead of .includes("no") or includesAny([..., "no", ...]).
const matchesWord = (value, terms) => {
  const values = toArray(value).map(text);
  return terms.some((term) =>
    values.some((v) => new RegExp(`\\b${term}\\b`, "i").test(v))
  );
};

const numberValue = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

const getPlatformAnswers = (audit, platform) => {
  const intakeResponse = audit.intakeResponses.find(
    (response) => response.section === `PLATFORM_${platform}`
  );

  return intakeResponse?.answers || {};
};

const getPlatformRecords = (dataset, platform) =>
  dataset?.data?.platforms?.[platform]?.records || [];

/**
 * Returns records filtered to a specific entity level. Reads the new
 * `byLevel` map first (post-entity-level normalization), falls back to
 * filtering `records` by the `level` field (legacy datasets).
 */
const getRecordsByLevel = (dataset, platform, level) => {
  const platformData = dataset?.data?.platforms?.[platform];
  if (!platformData) return [];

  if (platformData.byLevel?.[level]) return platformData.byLevel[level];

  return (platformData.records || []).filter(
    (record) => record.level === level
  );
};

// Name-based network fallback for when advertisingChannelType wasn't captured
// (CSV uploads, older pulls). Ordered most-specific first.
const googleNetworkFromName = (name) => {
  const n = text(name);
  if (!n) return null;
  if (/p-?max|performance\s*max/.test(n)) return "PMAX";
  if (/display|gdn/.test(n)) return "DISPLAY";
  if (/shopping|\bpla\b|merchant/.test(n)) return "SHOPPING";
  if (/video|youtube|\byt\b/.test(n)) return "VIDEO";
  if (/discovery|demand\s*gen/.test(n)) return "DEMAND_GEN";
  if (/search|brand|generic|keyword|\bkw\b/.test(n)) return "SEARCH";
  return null;
};

/**
 * The Google account's DOMINANT delivery network, weighted by spend — so CTR/CVR
 * are benchmarked against the network the budget actually runs on. Reads each
 * campaign's advertisingChannelType (normalized onto `objective`), falling back to
 * a name heuristic. Returns "SEARCH" | "DISPLAY" | "SHOPPING" | "VIDEO" | "PMAX" |
 * "DEMAND_GEN", or null when the network can't be determined (→ Search-calibrated
 * business-type table is used).
 */
export const resolveGoogleNetwork = (dataset) => {
  const camps = getRecordsByLevel(dataset, "GOOGLE", "campaign");
  if (!camps.length) return null;
  const spendByNet = {};
  for (const c of camps) {
    const spend = numberValue(c.spend);
    if (spend <= 0) continue;
    const net =
      GOOGLE_CHANNEL_MAP[String(c.objective || c.channelType || "").toUpperCase()] ||
      googleNetworkFromName(c.name);
    if (!net) continue;
    spendByNet[net] = (spendByNet[net] || 0) + spend;
  }
  const entries = Object.entries(spendByNet);
  if (!entries.length) return null;
  entries.sort((a, b) => b[1] - a[1]);
  return entries[0][0];
};

const isPausedStatus = (status) => {
  const value = text(status);
  if (!value) return false;
  return (
    value.includes("paused") ||
    value.includes("not delivering") ||
    value === "off"
  );
};

const isLearningStatus = (status) => text(status).includes("learning");

const isBroadMatch = (matchType) => text(matchType).includes("broad");
const isExactMatch = (matchType) => text(matchType).includes("exact");
const isPhraseMatch = (matchType) => text(matchType).includes("phrase");

/**
 * Top-N spend concentration: returns the share of total spend captured by
 * the top `share` (e.g. 0.2 for top 20%) of records ordered by spend desc.
 * If fewer than `minRecords` records or zero spend, returns null.
 */
const topSpendConcentration = (records, share = 0.2, minRecords = 5) => {
  const withSpend = records
    .map((record) => numberValue(record.spend))
    .filter((spend) => spend > 0)
    .sort((left, right) => right - left);

  if (withSpend.length < minRecords) return null;

  const total = withSpend.reduce((acc, spend) => acc + spend, 0);
  if (total <= 0) return null;

  const cutoff = Math.max(1, Math.ceil(withSpend.length * share));
  const topShareSpend = withSpend.slice(0, cutoff).reduce((a, b) => a + b, 0);

  return {
    share: topShareSpend / total,
    topCount: cutoff,
    totalCount: withSpend.length,
    topSpend: topShareSpend,
    totalSpend: total,
  };
};

const sumSpend = (records) =>
  records.reduce((total, record) => total + numberValue(record.spend), 0);

const sumImpressions = (records) =>
  records.reduce((total, record) => total + numberValue(record.impressions), 0);

const sumClicks = (records) =>
  records.reduce((total, record) => total + numberValue(record.clicks), 0);

const sumConversions = (records) =>
  records.reduce(
    (total, record) =>
      total + numberValue(record.conversions ?? record.results),
    0
  );

const getPlatformSummary = (dataset, platform) =>
  dataset?.summary?.platforms?.[platform] || {
    uploadedFiles: 0,
    rowCount: 0,
    spend: 0,
    impressions: 0,
    clicks: 0,
    conversions: 0,
    reach: 0,
  };

/**
 * Resolve the account's reporting currency for a finding's platform, falling
 * back to any platform's currency, then the account total.
 */
/** Normalised names of a platform's anomaly campaigns (empty set if none). */
const anomalyEntityNames = (dataset, platform) =>
  getPlatformSummary(dataset, platform)?.anomaly?.entityNames || new Set();

/**
 * The account baseline cost per result to compare segments/diagnostics against,
 * preferring the anomaly-quarantined ("trusted") baseline when a tracking-anomaly
 * campaign has collapsed the blended number. This is what stops segment- and
 * diagnostic-level findings from judging healthy placements/ages against the fake
 * PKR 53 the WhatsApp taps create, instead of the true ~PKR 115. Falls back to the
 * blended baseline when there is no anomaly.
 */
const trustedAccountBaseline = (dataset, platform) => {
  const summary = getPlatformSummary(dataset, platform);
  const trusted = summary?.anomaly?.trustedBaselineCpa;
  if (Number.isFinite(trusted) && trusted > 0) return trusted;
  return baselineCpa({ spend: summary.spend, conversions: summary.conversions });
};

/**
 * Account engagement metrics with the anomaly campaigns removed — the GENUINE
 * picture. A tracking anomaly (WhatsApp/Audience-Network taps) inflates not just
 * CPA but CTR and CPM: the fake clicks lift the blended CTR (6% reported vs ~2.4%
 * real) and contaminate every segment they touch. Any CTR/CPM read built on the
 * blended numbers — or on a "best segment" benchmark drawn from a contaminated
 * slice — is therefore unreliable. This is the single accessor those consumers
 * use so the de-contamination is centralised, not re-derived per rule.
 *
 * @returns {{ spend, impressions, clicks, conversions, ctr, hasAnomaly }}
 */
const genuineAccountMetrics = (dataset, platform) => {
  const excluded = anomalyEntityNames(dataset, platform);
  const campaigns = getRecordsByLevel(dataset, platform, "campaign");
  let spend = 0, impressions = 0, clicks = 0, conversions = 0;
  for (const c of campaigns) {
    if (excluded.has(normName(c.name))) continue;
    spend += numberValue(c.spend);
    impressions += numberValue(c.impressions);
    clicks += numberValue(c.clicks);
    conversions += numberValue(c.results ?? c.conversions);
  }
  return {
    spend,
    impressions,
    clicks,
    conversions,
    ctr: impressions > 0 ? (clicks / impressions) * 100 : null,
    hasAnomaly: excluded.size > 0,
  };
};

// Meta breakdown rows (placement/age/geo/…) blend campaigns of different result
// families but count only the dominant family's conversions — resultForFamilies
// returns the FIRST family with volume, so a segment that carries spend from a
// link-click/traffic campaign reports its messaging/lead conversions only and
// looks artificially expensive. The damage is severe only when a CLICK-tier
// family (link_click / landing_page_view — counts 10–50× a conversion's) shares
// material spend with a CONVERSION-tier family; two conversion families blend
// closely enough that the near-baseline margin + overlap reconciliation absorb
// it. When that severe mix is present, per-segment CPA can't be trusted, so the
// segment-waste rule stands down for Meta (campaign/geo/bidding findings, which
// don't depend on the breakdown conversion count, are unaffected).
const CLICK_TIER_FAMILIES = new Set(["link_click", "landing_page_view"]);
const FAMILY_MIX_MATERIAL_SHARE = 0.1;
const metaBreakdownFamiliesAreMixed = (dataset) => {
  const campaigns = getRecordsByLevel(dataset, "META", "campaign");
  const byFamily = new Map();
  let total = 0;
  for (const c of campaigns) {
    const fam = c.resultFamily;
    const spend = numberValue(c.spend);
    if (!fam || spend <= 0) continue;
    byFamily.set(fam, (byFamily.get(fam) || 0) + spend);
    total += spend;
  }
  if (total <= 0 || byFamily.size < 2) return false;
  let clickShare = 0;
  let conversionShare = 0;
  for (const [fam, spend] of byFamily) {
    if (CLICK_TIER_FAMILIES.has(fam)) clickShare += spend / total;
    else conversionShare += spend / total;
  }
  return clickShare >= FAMILY_MIX_MATERIAL_SHARE && conversionShare >= FAMILY_MIX_MATERIAL_SHARE;
};

// When the account has no DECLARED target CPA (intake left it blank), infer one
// from the campaigns' own Target-CPA bid settings — the goal the advertiser has
// already told Google. The median of the set is robust (no single campaign's
// stretch goal dominates). Needs ≥2 tCPA campaigns to be trustworthy; a single
// one is too thin to call an account target. Returns null otherwise. This is what
// lets the "CPA vs target" diagnosis fire on an account that set targets in the
// platform but not in our intake — without it the headline goes silent.
const TARGET_CPA_INFER_MIN_CAMPAIGNS = 2;
const inferAccountTargetCpa = (dataset, platform) => {
  const campaigns = getRecordsByLevel(dataset, platform, "campaign");
  const targets = campaigns
    .filter((c) => numberValue(c.spend) > 0)
    .map((c) => numberValue(c.targetCpa))
    .filter((t) => t > 0)
    .sort((a, b) => a - b);
  if (targets.length < TARGET_CPA_INFER_MIN_CAMPAIGNS) return null;
  const mid = Math.floor(targets.length / 2);
  const median =
    targets.length % 2 ? targets[mid] : (targets[mid - 1] + targets[mid]) / 2;
  return median > 0 ? Math.round(median * 100) / 100 : null;
};

/**
 * The target CPA to judge the account against: the declared intake target if
 * present, else one inferred from the campaigns' own tCPA settings (disclosed as
 * inferred). `{ value, source: 'declared'|'inferred'|'none' }`.
 */
const resolveTargetCpa = (audit, dataset, platform) => {
  const declared = numberValue(audit?.businessProfileSnapshot?.sectionA?.targetCpa);
  if (declared > 0) return { value: declared, source: "declared" };
  const inferred = inferAccountTargetCpa(dataset, platform);
  if (inferred && inferred > 0) return { value: inferred, source: "inferred" };
  return { value: 0, source: "none" };
};

const getReportCurrency = (dataset, platform) => {
  const direct = platform && dataset?.summary?.platforms?.[platform]?.currency;
  if (direct) return direct;
  const platforms = dataset?.summary?.platforms || {};
  for (const key of Object.keys(platforms)) {
    if (platforms[key]?.currency) return platforms[key].currency;
  }
  return dataset?.summary?.totals?.currency || null;
};

// The engine writes money as "$<number>". For non-USD accounts that mislabels
// the figure (a PKR account shown "$36,663" reads as if it spent dollars).
// Re-label the "$" marker with the account's currency code.
const localizeMoney = (value, currency) =>
  typeof value === "string" && currency && currency !== "USD"
    ? value.replace(/\$(?=\d)/g, `${currency} `)
    : value;

const formatMoney = (value, currency) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const formatted = Math.round(n).toLocaleString("en-US");
  return currency && currency !== "USD" ? `${currency} ${formatted}` : `$${formatted}`;
};

// Format a monetary value using the user's declared intake currency (budget,
// CPA etc.) — distinct from the ad-account reporting currency used by
// formatMoney/localizeMoney above.
const fmtIntake = (value, currency = "USD") => {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  const formatted = n % 1 === 0
    ? Math.round(n).toLocaleString("en-US")
    : n.toFixed(2);
  return currency && currency !== "USD" ? `${currency} ${formatted}` : `$${formatted}`;
};

/**
 * Rewrite hardcoded "$" money in finding copy to the account's real currency.
 * Applied once after all findings are built — single chokepoint, so every
 * rule's dollar figures are localized without threading currency into each.
 */
const localizeFindingsCurrency = (findings, dataset) => {
  for (const finding of findings) {
    const currency = getReportCurrency(dataset, finding.platform);
    if (!currency || currency === "USD") continue;
    finding.title = localizeMoney(finding.title, currency);
    finding.detail = localizeMoney(finding.detail, currency);
    finding.estimatedImpact = localizeMoney(finding.estimatedImpact, currency);
    if (Array.isArray(finding.fixSteps)) {
      finding.fixSteps = finding.fixSteps.map((step) =>
        localizeMoney(step, currency)
      );
    }
  }
  return findings;
};

const getTrackingCategory = (platform) =>
  ({ META: "Tracking & Pixel Health", GOOGLE: "Conversion Tracking Setup", TIKTOK: "Pixel & Tracking Health" })[platform] ||
  "Attribution & Reporting";

const getBiddingCategory = (platform) =>
  ({ META: "Bidding & Budget", GOOGLE: "Bidding Strategy Alignment", TIKTOK: "Bidding & Budget" })[platform] ||
  "Bidding & Budget";

const getAttributionCategory = (platform) =>
  ({ META: "Attribution & Reporting", GOOGLE: "Audience & Attribution", TIKTOK: "Attribution & Reporting" })[platform] ||
  "Attribution & Reporting";

const getBusinessProfile = (audit) => {
  const snapshot = audit.businessProfileSnapshot;
  if (!snapshot) return null;
  return {
    sectionA: snapshot.sectionA || {},
    sectionB: snapshot.sectionB || {},
    sectionC: snapshot.sectionC || {},
  };
};

const createFinding = ({
  ruleId,
  platform,
  severity,
  category,
  title,
  detail,
  rootCause,
  evidence,
  estimatedImpact,
  fixSteps,
}) => ({
  ruleId,
  platform,
  severity,
  category,
  title,
  detail,
  // Evidence-grounded "why this is happening". Rendered in the report instead of
  // a generic placeholder. Optional — rules populate it when they can diagnose
  // the driver from the data; the report falls back gracefully when absent.
  rootCause: rootCause || null,
  evidence,
  estimatedImpact,
  fixSteps,
});

const addMetaFindings = ({ audit, dataset, findings }) => {
  const answers = getPlatformAnswers(audit, "META");
  const records = getPlatformRecords(dataset, "META");
  const summary = getPlatformSummary(dataset, "META");

  if (records.length === 0) {
    findings.push(
      createFinding({
        ruleId: "DATA-001",
        platform: "META",
        severity: "CRITICAL",
        category: "Attribution & Reporting",
        title: "No validated Meta data was uploaded",
        detail: "The audit cannot evaluate Meta performance without validated Meta exports.",
        evidence: { uploadedRows: 0 },
        estimatedImpact: "Meta score is limited until account data is uploaded.",
        fixSteps: ["Upload a valid Meta ad, ad set, campaign, or pixel export."],
      })
    );
    return;
  }

  if (matchesWord(answers.M6, ["no"]) || text(answers.M6).includes("unsure")) {
    findings.push(
      createFinding({
        ruleId: "AUD-001",
        platform: "META",
        severity: "HIGH",
        category: "Audience Strategy",
        title: "Existing customer exclusion is not confirmed",
        detail: "Prospecting campaigns can waste spend if existing customers are not excluded.",
        evidence: { M6: answers.M6 },
        estimatedImpact: "Can inflate CPA by spending prospecting budget on existing buyers.",
        fixSteps: [
          "Create a customer list audience.",
          "Exclude it from prospecting ad sets.",
          "Keep the list refreshed from CRM or ecommerce purchases.",
        ],
      })
    );
  }

  if (matchesWord(answers.M5, ["no"])) {
    findings.push(
      createFinding({
        ruleId: "AUD-003",
        platform: "META",
        severity: "HIGH",
        category: "Retargeting Coverage",
        title: "No Meta retargeting campaign was reported",
        detail: "Warm audiences often convert more efficiently than cold traffic.",
        evidence: { M5: answers.M5 },
        estimatedImpact: "Missed low-funnel conversion opportunity.",
        fixSteps: [
          "Create retargeting audiences for site visitors and engaged users.",
          "Split short and longer recency windows where volume allows.",
        ],
      })
    );
  }

  const averageAds = numberValue(answers.M7);
  if (averageAds > 0 && (averageAds < 3 || averageAds > 8)) {
    findings.push(
      createFinding({
        ruleId: "STR-006",
        platform: "META",
        severity: "MEDIUM",
        category: "Campaign Structure",
        title: "Ad volume per ad set is outside the recommended range",
        detail: "Too few ads limits testing; too many ads can fragment delivery.",
        evidence: { averageAdsPerAdSet: averageAds },
        estimatedImpact: "Can slow creative learning and make winners harder to identify.",
        fixSteps: ["Keep roughly 3-8 active ads per ad set during testing."],
      })
    );
  }

  if (includesAny(answers.M8, ["monthly", "rarely"])) {
    findings.push(
      createFinding({
        ruleId: "CRE-001",
        platform: "META",
        severity: "HIGH",
        category: "Creative Performance",
        title: "Creative refresh cadence is slow",
        detail: "Stale creative usually causes fatigue and weaker engagement over time.",
        evidence: { M8: answers.M8 },
        estimatedImpact: "Can increase CPM and CPA as audiences tire of ads.",
        fixSteps: [
          "Create a recurring creative testing cadence.",
          "Refresh hooks, offers, formats, and angles at least bi-weekly where spend allows.",
        ],
      })
    );
  }

  if (summary.impressions > 0 && summary.reach > 0) {
    const frequency = summary.impressions / summary.reach;
    if (frequency > 5) {
      findings.push(
        createFinding({
          ruleId: "AUD-008",
          platform: "META",
          severity: "HIGH",
          category: "Audience Strategy",
          title: "Meta frequency is high",
          detail: "High frequency can indicate audience fatigue or over-narrow targeting.",
          evidence: { frequency: Number(frequency.toFixed(2)) },
          estimatedImpact: "Can increase wasted impressions and reduce conversion efficiency.",
          fixSteps: [
            "Refresh creative.",
            "Expand audience size.",
            "Separate retargeting frequency from prospecting frequency.",
          ],
        })
      );
    }
  }

  // ── Data-driven rules (require entity-level uploads) ──────────────────────

  const adsets = getRecordsByLevel(dataset, "META", "adset");
  const campaigns = getRecordsByLevel(dataset, "META", "campaign");
  const ads = getRecordsByLevel(dataset, "META", "ad");

  // STR-002: Paused ad sets with budget still assigned — wasted account hygiene
  // and a frequent cause of confusion when reviewing a Meta account.
  const pausedAdSetsWithBudget = adsets.filter(
    (record) => isPausedStatus(record.status) && numberValue(record.budget) > 0
  );
  if (pausedAdSetsWithBudget.length > 0) {
    findings.push(
      createFinding({
        ruleId: "STR-002",
        platform: "META",
        severity: "MEDIUM",
        category: "Campaign Structure",
        title: "Paused Meta ad sets still have budgets assigned",
        detail:
          "Paused ad sets with daily/lifetime budgets often confuse pacing reviews and may be re-enabled accidentally with stale targeting.",
        evidence: {
          pausedAdSetsWithBudget: pausedAdSetsWithBudget.length,
          examples: pausedAdSetsWithBudget
            .slice(0, 3)
            .map((record) => ({
              name: record.name,
              campaign: record.campaignName,
              budget: record.budget,
            })),
        },
        estimatedImpact: "Account hygiene and budget pacing decisions degrade.",
        fixSteps: [
          "Archive paused ad sets you don't intend to relaunch.",
          "For ad sets reserved for relaunch, document why budget is retained.",
        ],
      })
    );
  }

  // STR-007: Significant share of ad sets stuck in Learning phase
  if (adsets.length >= 5) {
    const learning = adsets.filter((record) =>
      isLearningStatus(record.learningPhase || record.status)
    );
    const learningShare = learning.length / adsets.length;
    if (learningShare >= 0.3) {
      findings.push(
        createFinding({
          ruleId: "STR-007",
          platform: "META",
          severity: "HIGH",
          category: "Campaign Structure",
          title: "Many Meta ad sets are stuck in the learning phase",
          detail:
            "Meta exits learning when an ad set hits ~50 optimization events in 7 days. A high share stuck in learning indicates fragmented budget or low conversion volume per ad set.",
          evidence: {
            adSetsTotal: adsets.length,
            adSetsLearning: learning.length,
            learningShare: Number((learningShare * 100).toFixed(1)),
          },
          estimatedImpact:
            "Optimization quality is reduced until ad sets exit learning.",
          fixSteps: [
            "Consolidate similar ad sets to increase per-ad-set conversion volume.",
            "Avoid major edits that restart learning.",
            "Use CBO/Advantage+ where appropriate to pool optimization signals.",
          ],
        })
      );
    }
  }

  // BID-004: Spend concentration — top 20% campaigns/ad sets capturing >80% spend
  const concentrationCampaigns = topSpendConcentration(campaigns, 0.2, 5);
  if (concentrationCampaigns && concentrationCampaigns.share >= 0.8) {
    findings.push(
      createFinding({
        ruleId: "BID-004",
        platform: "META",
        severity: "MEDIUM",
        category: "Bidding & Budget",
        title: "Meta spend is heavily concentrated in a few campaigns",
        detail:
          "Heavy concentration creates fragility: if a top spender's performance drops, account-level CPA spikes immediately.",
        evidence: {
          topSharePercent: Number((concentrationCampaigns.share * 100).toFixed(1)),
          topCount: concentrationCampaigns.topCount,
          totalCount: concentrationCampaigns.totalCount,
        },
        estimatedImpact:
          "Performance becomes brittle; one campaign's drop can sink the account.",
        fixSteps: [
          "Identify the top spending campaigns and document why they dominate.",
          "Plan diversification with new audiences or creative tracks.",
          "Set guardrails so a single campaign cannot exceed N% of total spend.",
        ],
      })
    );
  }

  // CRE-003: Ads with poor delivery rankings — only flag when meaningful sample
  if (ads.length >= 5) {
    const belowAverage = ads.filter((record) =>
      [
        record.qualityRanking,
        record.engagementRanking,
        record.conversionRanking,
      ].some((value) => text(value).includes("below average"))
    );
    if (belowAverage.length / ads.length >= 0.25) {
      const belowAverageSpend = sumSpend(belowAverage);
      findings.push(
        createFinding({
          ruleId: "CRE-003",
          platform: "META",
          severity: "HIGH",
          category: "Creative Performance",
          title: "Many Meta ads carry below-average delivery rankings",
          detail:
            "Quality, engagement, or conversion rankings flagged as below average inflate CPM and reduce delivery competitiveness.",
          evidence: {
            adsTotal: ads.length,
            adsBelowAverage: belowAverage.length,
            belowAverageShare: Number(
              ((belowAverage.length / ads.length) * 100).toFixed(1)
            ),
            spendOnBelowAverageAds: Math.round(belowAverageSpend),
          },
          estimatedImpact: `$${Math.round(belowAverageSpend).toLocaleString()} in spend is on below-average ranked ads. Replacing them with higher-quality creative reduces CPM and improves delivery competitiveness.`,
          fixSteps: [
            "Pause ads with multiple below-average rankings.",
            "Iterate on hooks, formats, and visual quality for retained creative.",
            "Run a fresh creative test focused on the weakest dimension.",
          ],
        })
      );
    }
  }

  // STR-008: Active campaigns spending with zero results — direct budget waste
  const totalMetaCampaignSpend = sumSpend(campaigns);
  if (campaigns.length >= 2 && totalMetaCampaignSpend > 0) {
    const minThreshold = Math.max(30, totalMetaCampaignSpend * 0.01);
    const zeroResult = campaigns.filter((record) => {
      const recordSpend = numberValue(record.spend);
      const recordResults = numberValue(record.results ?? record.conversions);
      return (
        recordSpend >= minThreshold &&
        recordResults === 0 &&
        !isPausedStatus(record.status)
      );
    });
    const zeroResultSpend = sumSpend(zeroResult);
    if (zeroResult.length > 0 && zeroResultSpend / totalMetaCampaignSpend >= 0.1) {
      findings.push(
        createFinding({
          ruleId: "STR-008",
          platform: "META",
          severity: zeroResultSpend / totalMetaCampaignSpend >= 0.3 ? "CRITICAL" : "HIGH",
          category: "Campaign Structure",
          title: "Active Meta campaigns are spending with zero recorded results",
          detail: `${zeroResult.length} active campaign(s) consumed $${Math.round(zeroResultSpend).toLocaleString()} without recording a single result. These campaigns are burning budget with no measured return.`,
          evidence: {
            zeroResultCampaigns: zeroResult.length,
            wastedSpend: Math.round(zeroResultSpend),
            wastedSharePercent: Number(
              ((zeroResultSpend / totalMetaCampaignSpend) * 100).toFixed(1)
            ),
            examples: zeroResult
              .slice(0, 3)
              .map((r) => ({ name: r.name, spend: Math.round(numberValue(r.spend)) })),
            ...(() => {
              const z = zeroConversionConfident({
                spend: zeroResultSpend,
                clicks: sumClicks(zeroResult),
              });
              return { confidence: z.confidence, sampleNote: z.sampleNote };
            })(),
          },
          estimatedImpact: `$${Math.round(zeroResultSpend).toLocaleString()} in spend produced zero recorded results. Pausing or restructuring these campaigns directly recovers this budget.`,
          fixSteps: [
            "Check whether the conversion event is correctly configured for each zero-result campaign.",
            "Review whether the campaign objective matches how you measure results.",
            "If the campaigns have been running more than 2 weeks with zero results, pause and restructure.",
            "Verify tracking is firing correctly — zero results can indicate a tracking break, not just poor performance.",
          ],
        })
      );
    }
  }

  // BID-005: Campaigns reporting ROAS < 1.0 — spend exceeds reported revenue
  const campaignsWithRoas = campaigns.filter(
    (record) => numberValue(record.roas) > 0 && numberValue(record.spend) > 50
  );
  if (campaignsWithRoas.length >= 1) {
    const lossMakers = campaignsWithRoas.filter(
      (record) => numberValue(record.roas) < 1.0
    );
    const lossMakersSpend = sumSpend(lossMakers);
    if (lossMakers.length > 0) {
      findings.push(
        createFinding({
          ruleId: "BID-005",
          platform: "META",
          severity:
            lossMakers.length >= campaignsWithRoas.length * 0.5 ? "CRITICAL" : "HIGH",
          category: "Bidding & Budget",
          title: "Meta campaigns reporting ROAS below 1.0 — spend exceeds attributed revenue",
          detail: `${lossMakers.length} campaign(s) with ROAS data are reporting ROAS below 1.0, meaning Meta attributes less than $1 in revenue for every $1 spent. Total spend on these campaigns: $${Math.round(lossMakersSpend).toLocaleString()}.`,
          evidence: {
            lossMakingCampaigns: lossMakers.length,
            totalCampaignsWithRoas: campaignsWithRoas.length,
            lossMakingSpend: Math.round(lossMakersSpend),
            examples: lossMakers.slice(0, 3).map((r) => ({
              name: r.name,
              roas: numberValue(r.roas).toFixed(2),
              spend: Math.round(numberValue(r.spend)),
            })),
          },
          estimatedImpact: `$${Math.round(lossMakersSpend).toLocaleString()} is flowing into campaigns where reported revenue is lower than cost. Note: Meta attribution often overcounts — real losses may be greater.`,
          fixSteps: [
            "Immediately reduce budgets on loss-making campaigns.",
            "Cross-reference Meta ROAS with GA4 or your analytics tool — Meta frequently overcounts conversions.",
            "Review offer, landing page, and audience on each loss-making campaign.",
            "Redirect budget from loss-makers to profitable campaigns.",
          ],
        })
      );
    }
  }

  // AUD-010: Ad-set level frequency above 7 — audience fatigue burning budget
  const highFreqAdSets = adsets.filter(
    (record) => numberValue(record.frequency) > 7 && numberValue(record.spend) > 30
  );
  if (highFreqAdSets.length > 0) {
    const highFreqSpend = sumSpend(highFreqAdSets);
    findings.push(
      createFinding({
        ruleId: "AUD-010",
        platform: "META",
        severity: "HIGH",
        category: "Audience Strategy",
        title: "Multiple Meta ad sets have very high frequency — audience fatigue is likely",
        detail: `${highFreqAdSets.length} ad set(s) have frequency above 7, meaning the average person has seen ads more than 7 times. At this level CPMs rise and conversion rates typically drop sharply.`,
        evidence: {
          highFreqAdSets: highFreqAdSets.length,
          highFreqSpend: Math.round(highFreqSpend),
          examples: highFreqAdSets.slice(0, 3).map((r) => ({
            name: r.name,
            frequency: numberValue(r.frequency).toFixed(1),
            spend: Math.round(numberValue(r.spend)),
          })),
        },
        estimatedImpact: `$${Math.round(highFreqSpend).toLocaleString()} is on saturated ad sets. Refreshing creative or expanding audiences typically restores CPM and conversion rates.`,
        fixSteps: [
          "Introduce new creative to fatigued ad sets immediately.",
          "Expand the audience size to dilute frequency.",
          "Split fatigued audiences into shorter recency windows to sequence messaging.",
          "Consider ad-level frequency caps on placements to prevent future saturation.",
        ],
      })
    );
  }
};

const addGoogleFindings = ({ audit, dataset, findings }) => {
  const answers = getPlatformAnswers(audit, "GOOGLE");
  const records = getPlatformRecords(dataset, "GOOGLE");
  const summary = getPlatformSummary(dataset, "GOOGLE");

  if (records.length === 0) {
    findings.push(
      createFinding({
        ruleId: "DATA-001",
        platform: "GOOGLE",
        severity: "CRITICAL",
        category: "Conversion Tracking Setup",
        title: "No validated Google data was uploaded",
        detail: "The audit cannot evaluate Google performance without validated Google exports.",
        evidence: { uploadedRows: 0 },
        estimatedImpact: "Google score is limited until account data is uploaded.",
        fixSteps: ["Upload a valid Google campaign, keyword, search term, or time-series export."],
      })
    );
    return;
  }

  if (matchesWord(answers.G11, ["no"])) {
    findings.push(
      createFinding({
        ruleId: "TRK-007",
        platform: "GOOGLE",
        severity: "HIGH",
        category: "Conversion Tracking Setup",
        title: "Enhanced Conversions are not configured — Smart Bidding is running on degraded signals",
        detail: `Enhanced Conversions fills the attribution gap caused by cookie consent, iOS privacy changes, and browser tracking restrictions. Without it, Google's Smart Bidding algorithms are receiving fewer and less accurate conversion signals, which directly degrades bid decisions across your $${Math.round(summary.spend || 0).toLocaleString()} in spend.`,
        evidence: { G11: answers.G11, totalSpend: Math.round(summary.spend || 0) },
        estimatedImpact: `Accounts that implement Enhanced Conversions typically recover 10–20% more attributed conversions from the same traffic — on $${Math.round(summary.spend || 0).toLocaleString()} in spend, better attribution directly improves Smart Bidding accuracy.`,
        fixSteps: [
          "Enable Enhanced Conversions for web in Google Ads conversion settings.",
          "Configure the enhanced conversion tag to capture hashed email or phone at purchase.",
          "Verify the diagnostic shows Enhanced Conversions data within 2–3 days of implementation.",
        ],
      })
    );
  }

  const monthlyConversions = numberValue(answers.G3) || summary.conversions;
  if (
    monthlyConversions < 50 &&
    includesAny(answers.G2, ["target cpa", "target roas"])
  ) {
    findings.push(
      createFinding({
        ruleId: "BID-001",
        platform: "GOOGLE",
        severity: "CRITICAL",
        category: "Bidding Strategy Alignment",
        title: "Smart bidding may not have enough conversion volume",
        detail: "Target CPA/ROAS strategies are risky when conversion volume is below 50 per month.",
        evidence: { monthlyConversions, G2: answers.G2 },
        estimatedImpact: "Can cause unstable delivery, missed volume, or poor CPA control.",
        fixSteps: [
          "Use Maximize Conversions or manual bidding while volume is low.",
          "Consolidate campaigns to increase conversion density where appropriate.",
        ],
      })
    );
  }

  if (matchesWord(answers.G5, ["no", "never"])) {
    findings.push(
      createFinding({
        ruleId: "KW-001",
        platform: "GOOGLE",
        severity: "CRITICAL",
        category: "Keyword Strategy",
        title: "No negative keyword process is confirmed",
        detail: `Without a confirmed negative keyword process, all $${Math.round(summary.spend || 0).toLocaleString()} in Google spend is exposed to irrelevant search queries. Industry data shows 10–30% of search spend in unmanaged accounts flows to low-intent or completely irrelevant searches. Establishing a weekly search term review is the single highest-leverage Google optimisation for accounts without it.`,
        evidence: { G5: answers.G5, totalSpend: Math.round(summary.spend || 0) },
        estimatedImpact: `10–30% of your $${Math.round(summary.spend || 0).toLocaleString()} in Google spend ($${Math.round((summary.spend || 0) * 0.15).toLocaleString()} estimated at a conservative 15%) may be flowing to irrelevant queries without a negative keyword review process.`,
        fixSteps: [
          "Pull search term reports for the last 30 days across all campaigns.",
          "Create shared negative keyword lists and apply them account-wide.",
          "Separate brand-protection negatives from generic irrelevant query negatives.",
          "Schedule a weekly 30-minute search term review as a recurring media buyer task.",
        ],
      })
    );
  }

  if (includesAny(answers.G5, ["6+ months"])) {
    findings.push(
      createFinding({
        ruleId: "KW-002",
        platform: "GOOGLE",
        severity: "HIGH",
        category: "Keyword Strategy",
        title: "Negative keyword list appears stale",
        detail: "Search query behavior changes over time, especially after campaign changes.",
        evidence: { G5: answers.G5 },
        estimatedImpact: "Can gradually increase irrelevant spend.",
        fixSteps: ["Review recent search terms and update shared negative lists."],
      })
    );
  }

  if (
    includesAny(answers.G4, ["broad"]) &&
    includesAny(answers.G2, ["manual cpc", "maximize clicks"])
  ) {
    findings.push(
      createFinding({
        ruleId: "KW-006",
        platform: "GOOGLE",
        severity: "HIGH",
        category: "Keyword Strategy",
        title: "Broad match is paired with weak bidding controls",
        detail: "Broad match generally needs strong conversion signals and bidding guardrails.",
        evidence: { G4: answers.G4, G2: answers.G2 },
        estimatedImpact: "Can spend on loose intent queries.",
        fixSteps: [
          "Use phrase/exact match where conversion volume is limited.",
          "Pair broad match with conversion-based bidding and strong negatives.",
        ],
      })
    );
  }

  if (matchesWord(answers.G8, ["no"]) || text(answers.G8).includes("unsure")) {
    findings.push(
      createFinding({
        ruleId: "AUD-006",
        platform: "GOOGLE",
        severity: "MEDIUM",
        category: "Audience & Attribution",
        title: "Audience observation layers are not confirmed — bid adjustment data is missing",
        detail: `Without observation audiences, Google campaigns have no data on which audience segments (remarketing lists, customer match, in-market segments) over- or under-perform. This removes the ability to apply bid adjustments that could reduce CPA or increase ROAS across your $${Math.round(summary.spend || 0).toLocaleString()} in spend.`,
        evidence: { G8: answers.G8, totalSpend: Math.round(summary.spend || 0) },
        estimatedImpact: "Bid adjustments on observation audiences typically improve CPA 10–20% by shifting budget toward segments with demonstrated higher intent.",
        fixSteps: [
          "Add remarketing lists (site visitors, cart abandoners, past converters) in observation mode to all campaigns.",
          "Add customer match lists from CRM data in observation mode.",
          "After 30 days of data, apply positive bid adjustments to high-converting segments.",
        ],
      })
    );
  }

  // ── Data-driven rules (require entity-level uploads) ──────────────────────

  const googleCampaigns = getRecordsByLevel(dataset, "GOOGLE", "campaign");
  const keywords = getRecordsByLevel(dataset, "GOOGLE", "keyword");
  const searchTerms = getRecordsByLevel(dataset, "GOOGLE", "search_term");

  // KW-007: Broad-match spend share — broad match without conversion bidding
  // is the #1 source of Google waste in our experience.
  if (keywords.length >= 5) {
    const broad = keywords.filter((record) => isBroadMatch(record.matchType));
    const broadSpend = sumSpend(broad);
    const totalKwSpend = sumSpend(keywords);

    if (totalKwSpend > 0) {
      const broadShare = broadSpend / totalKwSpend;
      if (broadShare >= 0.5) {
        findings.push(
          createFinding({
            ruleId: "KW-007",
            platform: "GOOGLE",
            severity: "HIGH",
            category: "Keyword Strategy",
            title: "Most Google keyword spend is on broad match",
            detail:
              "More than half of keyword spend is on broad match. Without strong conversion signals and tight negatives, broad match commonly bleeds budget into low-intent searches.",
            evidence: {
              broadShare: Number((broadShare * 100).toFixed(1)),
              broadSpend: Math.round(broadSpend),
              totalKeywordSpend: Math.round(totalKwSpend),
              broadKeywords: broad.length,
              totalKeywords: keywords.length,
            },
            estimatedImpact: `$${Math.round(broadSpend).toLocaleString()} (${Number((broadShare * 100).toFixed(1))}% of keyword budget) is on broad match. Migrating proven converters to phrase or exact match typically recovers 15-30% of that spend through reduced irrelevant traffic.`,
            fixSteps: [
              "Pull last 30 days of search terms — flag irrelevant queries.",
              "Move proven converters to phrase or exact match.",
              "Tighten negative keyword lists before scaling broad match.",
            ],
          })
        );
      }
    }
  }

  // KW-005: Quality Score < 5 share among keywords with meaningful spend.
  if (keywords.length >= 10) {
    const qualified = keywords.filter(
      (record) => numberValue(record.qualityScore) > 0
    );
    if (qualified.length >= 10) {
      const lowQs = qualified.filter(
        (record) => numberValue(record.qualityScore) < 5
      );
      const lowQsShare = lowQs.length / qualified.length;
      const lowQsSpend = sumSpend(lowQs);
      if (lowQsShare >= 0.3) {
        // Diagnose WHICH component drags QS, so the fix points at the right lever
        // (ad relevance vs. landing page vs. expected CTR) instead of guessing.
        const COMPONENTS = [
          { key: "adRelevance", label: "ad relevance", fix: "tighten ad groups so the keyword appears in the headlines and the ad speaks to that exact intent" },
          { key: "landingPageExperience", label: "landing page experience", fix: "point the keyword at a page that matches its intent and improve relevance, transparency, and load speed" },
          { key: "expectedCtr", label: "expected click-through rate", fix: "rewrite ad copy with stronger hooks/offers and add the keyword to headlines to lift expected CTR" },
        ];
        const isBelow = (v) => text(v).includes("below");
        const componentCounts = COMPONENTS.map((c) => ({
          ...c,
          below: lowQs.filter((kw) => isBelow(kw[c.key])).length,
        })).sort((a, b) => b.below - a.below);
        const dominant = componentCounts[0].below > 0 ? componentCounts[0] : null;

        const componentDetail = dominant
          ? ` The dominant driver is ${dominant.label}: ${dominant.below} of the ${lowQs.length} low-QS keywords are rated Below Average there — so the highest-leverage fix is to ${dominant.fix}.`
          : "";
        const fixSteps = dominant
          ? [
              `Start with ${dominant.label}: ${dominant.fix.charAt(0).toUpperCase() + dominant.fix.slice(1)}.`,
              "Group the remaining low-QS keywords by ad group and align keyword, ad copy, and landing page.",
              "Re-check Quality Score components after a full cycle and address the next weakest.",
            ]
          : [
              "Group low-QS keywords by ad group and review match between keyword, ad copy, and landing page.",
              "Tighten ad groups around shared intent so headlines can include the keyword.",
              "Improve landing page relevance and load speed.",
            ];

        findings.push(
          createFinding({
            ruleId: "KW-005",
            platform: "GOOGLE",
            severity: "HIGH",
            category: "Quality Score & Relevance",
            title: dominant
              ? `Low Quality Score on a large share of keywords — driven by ${dominant.label}`
              : "A large share of Google keywords have a Quality Score under 5",
            detail:
              "Low Quality Score raises CPCs and weakens ad rank. A persistent low-QS share often signals weak ad-keyword-LP alignment." +
              componentDetail,
            rootCause: dominant
              ? `${dominant.label.charAt(0).toUpperCase() + dominant.label.slice(1)} is rated Below Average on most low-QS keywords, which is the component pulling Quality Score down and inflating CPCs.`
              : null,
            evidence: {
              lowQsKeywords: lowQs.length,
              evaluatedKeywords: qualified.length,
              lowQsShare: Number((lowQsShare * 100).toFixed(1)),
              lowQsSpend: Math.round(lowQsSpend),
              dominantWeakComponent: dominant?.label || null,
              componentBelowAverageCounts: Object.fromEntries(
                componentCounts.map((c) => [c.key, c.below])
              ),
            },
            estimatedImpact: `$${Math.round(lowQsSpend).toLocaleString()} in spend is attributed to low Quality Score keywords. Improving QS to 7+${dominant ? ` (starting with ${dominant.label})` : ""} reduces CPCs and improves Ad Rank without spending more.`,
            fixSteps,
          })
        );
      }
    }
  }

  // KW-003: Search-term irrelevance — high-impression search terms with zero
  // conversions consuming meaningful spend.
  if (searchTerms.length >= 10) {
    const totalStSpend = sumSpend(searchTerms);
    const wasted = searchTerms.filter(
      (record) =>
        numberValue(record.spend) > 0 &&
        numberValue(record.conversions) === 0 &&
        numberValue(record.clicks) >= 5
    );
    const wastedSpend = sumSpend(wasted);
    const wastedShare = totalStSpend > 0 ? wastedSpend / totalStSpend : 0;

    if (wastedShare >= 0.2 && wasted.length >= 5) {
      findings.push(
        createFinding({
          ruleId: "KW-003",
          platform: "GOOGLE",
          severity: "HIGH",
          category: "Keyword Strategy",
          title: "Significant Google spend on search terms with no conversions",
          detail:
            "Search terms with at least 5 clicks and zero conversions are strong negative-keyword candidates. They are visibly burning budget without contributing to results.",
          evidence: {
            wastedSearchTerms: wasted.length,
            totalSearchTerms: searchTerms.length,
            wastedSpend: Math.round(wastedSpend),
            wastedSharePercent: Number((wastedShare * 100).toFixed(1)),
            examples: wasted
              .sort(
                (a, b) => numberValue(b.spend) - numberValue(a.spend)
              )
              .slice(0, 5)
              .map((record) => ({
                searchTerm: record.searchTerm,
                spend: Math.round(numberValue(record.spend)),
                clicks: numberValue(record.clicks),
              })),
          },
          estimatedImpact: `$${Math.round(wastedSpend).toLocaleString()} in spend went to search terms with zero conversions. Adding these as negatives directly recaptures this budget on the next billing cycle.`,
          fixSteps: [
            "Review the highest-spend non-converting search terms.",
            "Add irrelevant terms to a shared negative keyword list.",
            "Consider exact-match conversions only for the affected ad groups.",
          ],
        })
      );
    }
  }

  // STR-001: Budget fragmentation — many low-spend campaigns starve smart bidding
  if (googleCampaigns.length >= 6) {
    const totalGoogleSpend = sumSpend(googleCampaigns);
    if (totalGoogleSpend > 0) {
      const lowSpend = googleCampaigns.filter((record) => {
        const spend = numberValue(record.spend);
        return spend > 0 && spend / totalGoogleSpend < 0.05;
      });
      if (lowSpend.length / googleCampaigns.length >= 0.5) {
        findings.push(
          createFinding({
            ruleId: "STR-001",
            platform: "GOOGLE",
            severity: "MEDIUM",
            category: "Campaign Structure",
            title: "Google campaign budgets look fragmented",
            detail:
              "Most campaigns each consume <5% of total spend. Fragmented budgets prevent any campaign from accumulating enough conversion volume for stable smart bidding.",
            evidence: {
              campaignsTotal: googleCampaigns.length,
              lowSpendCampaigns: lowSpend.length,
              totalSpend: Math.round(totalGoogleSpend),
            },
            estimatedImpact:
              "Smart bidding learning is unstable; many campaigns underperform their potential.",
            fixSteps: [
              "Consolidate campaigns with similar audiences/objectives.",
              "Use shared budgets where appropriate.",
              "Pause clearly underperforming campaigns and reallocate.",
            ],
          })
        );
      }
    }
  }

  // BID-004: Spend concentration on Google
  const concentrationGoogle = topSpendConcentration(googleCampaigns, 0.2, 5);
  if (concentrationGoogle && concentrationGoogle.share >= 0.8) {
    findings.push(
      createFinding({
        ruleId: "BID-004",
        platform: "GOOGLE",
        severity: "MEDIUM",
        category: "Bidding Strategy Alignment",
        title: "Google spend is heavily concentrated in a few campaigns",
        detail:
          "When 80%+ of spend lives in 20% of campaigns, the account is fragile to one campaign drifting off target.",
        evidence: {
          topSharePercent: Number(
            (concentrationGoogle.share * 100).toFixed(1)
          ),
          topCount: concentrationGoogle.topCount,
          totalCount: concentrationGoogle.totalCount,
        },
        estimatedImpact:
          "Single-point-of-failure risk for the Google channel.",
        fixSteps: [
          "Document why concentration is so high — is it strategy or drift?",
          "Plan diversification: new keyword themes, audiences, or campaign types.",
        ],
      })
    );
  }

  // STR-009: Active Google campaigns with meaningful spend and zero conversions
  if (googleCampaigns.length >= 2) {
    const totalGoogleCampaignSpend2 = sumSpend(googleCampaigns);
    const minGoogleThreshold = Math.max(50, totalGoogleCampaignSpend2 * 0.01);
    const zeroConvCampaigns = googleCampaigns.filter((record) => {
      const recordSpend = numberValue(record.spend);
      // Google campaign records store conversions as `results`; fall back so we
      // don't flag converting campaigns as zero-conversion (false positive).
      const recordConversions = numberValue(record.conversions ?? record.results);
      return (
        recordSpend >= minGoogleThreshold &&
        recordConversions === 0 &&
        !isPausedStatus(record.status)
      );
    });
    const zeroConvSpend = sumSpend(zeroConvCampaigns);
    if (
      zeroConvCampaigns.length > 0 &&
      totalGoogleCampaignSpend2 > 0 &&
      zeroConvSpend / totalGoogleCampaignSpend2 >= 0.1
    ) {
      findings.push(
        createFinding({
          ruleId: "STR-009",
          platform: "GOOGLE",
          severity: zeroConvSpend / totalGoogleCampaignSpend2 >= 0.3 ? "CRITICAL" : "HIGH",
          category: "Conversion Tracking Setup",
          title: "Google campaigns are spending with zero recorded conversions",
          detail: `${zeroConvCampaigns.length} active campaign(s) consumed $${Math.round(zeroConvSpend).toLocaleString()} without recording a single conversion. These campaigns are generating clicks but no measurable return.`,
          evidence: {
            zeroConvCampaigns: zeroConvCampaigns.length,
            wastedSpend: Math.round(zeroConvSpend),
            wastedSharePercent: Number(
              ((zeroConvSpend / totalGoogleCampaignSpend2) * 100).toFixed(1)
            ),
            examples: zeroConvCampaigns
              .slice(0, 3)
              .map((r) => ({ name: r.name, spend: Math.round(numberValue(r.spend)) })),
            ...(() => {
              const z = zeroConversionConfident({
                spend: zeroConvSpend,
                clicks: sumClicks(zeroConvCampaigns),
              });
              return { confidence: z.confidence, sampleNote: z.sampleNote };
            })(),
          },
          estimatedImpact: `$${Math.round(zeroConvSpend).toLocaleString()} produced zero conversions. This is either a tracking problem or a structural inefficiency that compounds with every day of continued spend.`,
          fixSteps: [
            "First rule out a tracking issue: check Conversion Actions and verify tag firing in Google Tag Assistant.",
            "If tracking is confirmed, pause zero-conversion campaigns and diagnose: keyword relevance, landing page quality, and bid strategy.",
            "If these are brand-new campaigns, allow at least 2 weeks and ~50 clicks per ad group before drawing conclusions.",
            "Consider switching to Maximize Conversions (without a target CPA) to let Google learn before adding constraints.",
          ],
        })
      );
    }
  }

  // BID-005: Campaigns where conversion value < spend — ROAS below 1.0 and directly unprofitable
  const campaignsWithConvValue = googleCampaigns.filter(
    (r) => numberValue(r.convValue) > 0 && numberValue(r.spend) > 50
  );
  if (campaignsWithConvValue.length >= 1) {
    const lossMakers = campaignsWithConvValue.filter(
      (r) => numberValue(r.convValue) < numberValue(r.spend)
    );
    const lossMakersSpend = sumSpend(lossMakers);
    if (lossMakers.length > 0) {
      findings.push(
        createFinding({
          ruleId: "BID-005",
          platform: "GOOGLE",
          severity: "CRITICAL",
          category: "Bidding Strategy Alignment",
          title: "Google campaigns have conversion value below spend — these campaigns are directly unprofitable",
          detail: `${lossMakers.length} campaign(s) show conversion value lower than cost, meaning a ROAS below 1.0. Google is reporting less revenue than you are spending on these campaigns.`,
          evidence: {
            lossMakingCampaigns: lossMakers.length,
            totalCampaignsWithValue: campaignsWithConvValue.length,
            lossMakingSpend: Math.round(lossMakersSpend),
            examples: lossMakers.slice(0, 3).map((r) => ({
              name: r.name,
              spend: Math.round(numberValue(r.spend)),
              convValue: Math.round(numberValue(r.convValue)),
              roas: (numberValue(r.convValue) / numberValue(r.spend)).toFixed(2),
            })),
          },
          estimatedImpact: `$${Math.round(lossMakersSpend).toLocaleString()} is flowing into campaigns where Google reports less than $1 in value per $1 spent. Every additional day of spend deepens the loss.`,
          fixSteps: [
            "Immediately reduce budgets on loss-making campaigns.",
            "Verify conversion values are being passed correctly — check the gtag conversionValue parameter.",
            "Cross-check with your order management system: Google's reported value may differ from actual revenue.",
            "Review keyword-to-landing-page alignment and offer quality on the affected campaigns.",
          ],
        })
      );
    }
  }

  // KW-010: Active keywords with zero impressions — disapproved, below first-page bid, or policy-limited
  if (keywords.length >= 5) {
    const activeKeywords = keywords.filter(
      (record) =>
        !text(record.status).includes("paused") &&
        !text(record.status).includes("removed")
    );
    const activeZeroImpression = activeKeywords.filter(
      (record) =>
        numberValue(record.impressions) === 0 && numberValue(record.spend) === 0
    );
    if (
      activeKeywords.length > 0 &&
      activeZeroImpression.length > 0 &&
      activeZeroImpression.length / activeKeywords.length >= 0.2
    ) {
      findings.push(
        createFinding({
          ruleId: "KW-010",
          platform: "GOOGLE",
          severity: "MEDIUM",
          category: "Keyword Strategy",
          title: "Many active Google keywords are getting zero impressions",
          detail: `${activeZeroImpression.length} active keyword(s) (${Math.round((activeZeroImpression.length / activeKeywords.length) * 100)}% of active keywords) received zero impressions in the data period. Common causes: bid below first page, low search volume, disapproval, or keyword-level policy restrictions.`,
          evidence: {
            zeroImpressionKeywords: activeZeroImpression.length,
            activeKeywordsTotal: activeKeywords.length,
            zeroImpressionSharePercent: Number(
              ((activeZeroImpression.length / activeKeywords.length) * 100).toFixed(1)
            ),
            examples: activeZeroImpression
              .slice(0, 5)
              .map((r) => ({ keyword: r.keyword, matchType: r.matchType, status: r.status })),
          },
          estimatedImpact:
            "Zero-impression active keywords inflate account clutter, mask Quality Score problems, and can indicate disapproved ads that need immediate attention.",
          fixSteps: [
            "Check Google Ads status column for 'Below first page bid', 'Low search volume', or 'Disapproved'.",
            "Pause keywords labelled 'Low search volume' — they consume account resources without contributing.",
            "For keywords showing 'Below first page bid', evaluate whether raising the bid is justified by relevance.",
            "Remove duplicate keywords that overlap with better-performing broad or phrase match versions.",
          ],
        })
      );
    }
  }

  // AD-001: RSA asset performance — high share of 'Low' rated assets
  const assets = getRecordsByLevel(dataset, "GOOGLE", "asset");
  if (assets.length >= 5) {
    const ratedAssets = assets.filter(
      (r) =>
        text(r.performance).includes("low") ||
        text(r.performance).includes("good") ||
        text(r.performance).includes("best")
    );
    const lowPerfAssets = ratedAssets.filter((r) =>
      text(r.performance).includes("low")
    );
    if (ratedAssets.length >= 5 && lowPerfAssets.length / ratedAssets.length >= 0.4) {
      findings.push(
        createFinding({
          ruleId: "AD-001",
          platform: "GOOGLE",
          severity: "MEDIUM",
          category: "Ad Copy & Extensions",
          title: "A large share of Google RSA assets are rated 'Low' — ad competitiveness is reduced",
          detail: `${lowPerfAssets.length} of ${ratedAssets.length} rated RSA asset(s) carry a 'Low' performance label. Google uses this rating to determine how often each headline and description is shown. A high proportion of low-rated assets reduces Ad Strength and delivery competitiveness.`,
          evidence: {
            lowPerfAssets: lowPerfAssets.length,
            ratedAssets: ratedAssets.length,
            lowPerfSharePercent: Number(
              ((lowPerfAssets.length / ratedAssets.length) * 100).toFixed(1)
            ),
            examples: lowPerfAssets
              .slice(0, 3)
              .map((r) => ({ asset: r.asset, type: r.type })),
          },
          estimatedImpact:
            "RSAs with many 'Low' assets receive lower Ad Strength scores and are served less frequently. Replacing them with message-matched alternatives improves CTR and Ad Rank without changing bids.",
          fixSteps: [
            "Remove or replace 'Low'-rated assets with new headline/description variations.",
            "Ensure each RSA includes at least 3 headlines containing the primary keyword.",
            "Test benefit-focused and offer-focused headlines against each other.",
            "Avoid pinning headlines unless absolutely necessary — pinning removes Google's ability to optimise combinations.",
          ],
        })
      );
    }
  }
};

const addTikTokFindings = ({ audit, dataset, findings }) => {
  const answers = getPlatformAnswers(audit, "TIKTOK");
  const records = getPlatformRecords(dataset, "TIKTOK");

  if (records.length === 0) {
    findings.push(
      createFinding({
        ruleId: "DATA-001",
        platform: "TIKTOK",
        severity: "CRITICAL",
        category: "Attribution & Reporting",
        title: "No validated TikTok data was uploaded",
        detail: "The audit cannot evaluate TikTok performance without validated TikTok exports.",
        evidence: { uploadedRows: 0 },
        estimatedImpact: "TikTok score is limited until account data is uploaded.",
        fixSteps: ["Upload a valid TikTok campaign, ad group, ad, or pixel export."],
      })
    );
    return;
  }

  if (includesAny(answers.T5, ["neither"])) {
    findings.push(
      createFinding({
        ruleId: "TRK-001",
        platform: "TIKTOK",
        severity: "CRITICAL",
        category: "Pixel & Tracking Health",
        title: "TikTok Pixel or Events API is not configured",
        detail: "TikTok optimization needs event signals to learn from conversion behavior.",
        evidence: { T5: answers.T5 },
        estimatedImpact: "Can prevent accurate conversion optimization.",
        fixSteps: [
          "Install TikTok Pixel.",
          "Configure key conversion events.",
          "Add Events API when engineering support is available.",
        ],
      })
    );
  }

  if (includesAny(answers.T5, ["pixel only"])) {
    findings.push(
      createFinding({
        ruleId: "TRK-003",
        platform: "TIKTOK",
        severity: "HIGH",
        category: "Pixel & Tracking Health",
        title: "Events API is not implemented",
        detail: "Server-side events improve signal reliability when browser tracking is limited.",
        evidence: { T5: answers.T5 },
        estimatedImpact: "Can reduce event match quality and optimization stability.",
        fixSteps: ["Plan Events API implementation for high-value conversion events."],
      })
    );
  }

  if (includesAny(answers.T3, ["monthly", "rarely"])) {
    findings.push(
      createFinding({
        ruleId: "CRE-001",
        platform: "TIKTOK",
        severity: "HIGH",
        category: "Creative Performance",
        title: "TikTok creative refresh cadence is too slow",
        detail: "TikTok fatigue cycles are usually faster than Meta or Google.",
        evidence: { T3: answers.T3 },
        estimatedImpact: "Can quickly reduce CTR and increase CPA.",
        fixSteps: [
          "Produce new hooks weekly where spend allows.",
          "Rotate creator, format, angle, and first-three-second opening.",
        ],
      })
    );
  }

  if (matchesWord(answers.T8, ["no"]) || text(answers.T8).includes("unsure")) {
    findings.push(
      createFinding({
        ruleId: "AUD-001",
        platform: "TIKTOK",
        severity: "HIGH",
        category: "Audience Strategy",
        title: "Existing customer exclusion is not confirmed",
        detail: "Prospecting campaigns can waste budget on people who already purchased.",
        evidence: { T8: answers.T8 },
        estimatedImpact: "Can overstate prospecting performance and inflate CAC.",
        fixSteps: ["Exclude customer lists from prospecting ad groups where possible."],
      })
    );
  }

  const pausedWithBudget = records.filter(
    (record) => isPausedStatus(record.status) && numberValue(record.budget) > 0
  );

  if (pausedWithBudget.length > 0) {
    findings.push(
      createFinding({
        ruleId: "STR-005",
        platform: "TIKTOK",
        severity: "MEDIUM",
        category: "Campaign Structure",
        title: "Paused TikTok campaigns still show budget",
        detail: "Paused campaigns with budgets can confuse account review and budget planning.",
        evidence: { pausedCampaigns: pausedWithBudget.length },
        estimatedImpact: "Budget visibility and pacing decisions become less reliable.",
        fixSteps: ["Clean up paused campaigns or document why budget remains assigned."],
      })
    );
  }

  // ── Data-driven rules ─────────────────────────────────────────────────────

  const tiktokCampaigns = getRecordsByLevel(dataset, "TIKTOK", "campaign");
  const tiktokAds = getRecordsByLevel(dataset, "TIKTOK", "ad");

  // BID-004: TikTok spend concentration
  const tiktokConcentration = topSpendConcentration(tiktokCampaigns, 0.2, 4);
  if (tiktokConcentration && tiktokConcentration.share >= 0.8) {
    findings.push(
      createFinding({
        ruleId: "BID-004",
        platform: "TIKTOK",
        severity: "MEDIUM",
        category: "Bidding & Budget",
        title: "TikTok spend is heavily concentrated in a few campaigns",
        detail:
          "TikTok performance can swing fast on creative. Heavy spend concentration amplifies that risk.",
        evidence: {
          topSharePercent: Number(
            (tiktokConcentration.share * 100).toFixed(1)
          ),
          topCount: tiktokConcentration.topCount,
          totalCount: tiktokConcentration.totalCount,
        },
        estimatedImpact:
          "Account-level CPA can swing sharply when a single campaign's creative fatigues.",
        fixSteps: [
          "Diversify across creative themes or audiences.",
          "Set per-campaign spend ceilings to limit single-point risk.",
        ],
      })
    );
  }

  // CRE-002: Low-CTR TikTok ads carrying significant spend (proxy for hook rate)
  if (tiktokAds.length >= 5) {
    const totalAdSpend = sumSpend(tiktokAds);
    const lowCtr = tiktokAds.filter((record) => {
      const ctr = numberValue(record.ctr);
      const spend = numberValue(record.spend);
      return ctr > 0 && ctr < 0.5 && spend > 0;
    });
    const lowCtrSpend = sumSpend(lowCtr);
    if (
      totalAdSpend > 0 &&
      lowCtrSpend / totalAdSpend >= 0.3 &&
      lowCtr.length >= 3
    ) {
      findings.push(
        createFinding({
          ruleId: "CRE-002",
          platform: "TIKTOK",
          severity: "HIGH",
          category: "Creative Performance",
          title: "Significant TikTok spend is going to low-CTR ads",
          detail:
            "When ads with CTR under 0.5% absorb 30%+ of spend, the creative is failing to earn attention. CTR in the 1-2%+ range is typical for healthy TikTok ads.",
          evidence: {
            lowCtrAds: lowCtr.length,
            totalAds: tiktokAds.length,
            lowCtrSpend: Math.round(lowCtrSpend),
            lowCtrSpendShare: Number(
              ((lowCtrSpend / totalAdSpend) * 100).toFixed(1)
            ),
          },
          estimatedImpact: `$${Math.round(lowCtrSpend).toLocaleString()} (${Number(((lowCtrSpend / totalAdSpend) * 100).toFixed(1))}% of ad spend) is going to ads with CTR below 0.5%. Reallocating to stronger creative directly improves ROAS without increasing budget.`,
          fixSteps: [
            "Pause the lowest-CTR ads and shift budget to top performers.",
            "Test stronger 1-3 second hooks on remaining ads.",
            "Iterate on creator, format, and pattern interrupts.",
          ],
        })
      );
    }
  }

  // STR-008: TikTok campaigns with spend and zero conversions
  if (tiktokCampaigns.length >= 2) {
    const totalTikTokSpend = sumSpend(tiktokCampaigns);
    const minTikTokThreshold = Math.max(30, totalTikTokSpend * 0.01);
    const zeroConvTikTok = tiktokCampaigns.filter((record) => {
      const recordSpend = numberValue(record.spend);
      const recordConversions = numberValue(record.conversions);
      return recordSpend >= minTikTokThreshold && recordConversions === 0;
    });
    const zeroConvTikTokSpend = sumSpend(zeroConvTikTok);
    if (
      zeroConvTikTok.length > 0 &&
      totalTikTokSpend > 0 &&
      zeroConvTikTokSpend / totalTikTokSpend >= 0.1
    ) {
      findings.push(
        createFinding({
          ruleId: "STR-008",
          platform: "TIKTOK",
          severity: zeroConvTikTokSpend / totalTikTokSpend >= 0.3 ? "CRITICAL" : "HIGH",
          category: "Campaign Structure",
          title: "TikTok campaigns are spending with zero recorded conversions",
          detail: `${zeroConvTikTok.length} TikTok campaign(s) consumed $${Math.round(zeroConvTikTokSpend).toLocaleString()} without recording a single conversion. On TikTok, zero conversions after meaningful spend almost always points to a pixel issue, wrong optimisation event, or creative that cannot bridge the intent gap to purchase.`,
          evidence: {
            zeroConvCampaigns: zeroConvTikTok.length,
            wastedSpend: Math.round(zeroConvTikTokSpend),
            wastedSharePercent: Number(
              ((zeroConvTikTokSpend / totalTikTokSpend) * 100).toFixed(1)
            ),
            examples: zeroConvTikTok
              .slice(0, 3)
              .map((r) => ({ name: r.name, spend: Math.round(numberValue(r.spend)) })),
          },
          estimatedImpact: `$${Math.round(zeroConvTikTokSpend).toLocaleString()} produced no conversions. This is either a tracking problem or the creative is not generating purchase intent.`,
          fixSteps: [
            "Check TikTok Pixel Helper to confirm the pixel fires on the conversion page.",
            "Verify the optimisation event (e.g. CompletePayment) is recording in TikTok Events Manager.",
            "If tracking is confirmed, review creative: the hook, offer, and CTA must match the audience's buying intent.",
            "Test with a Broad Audience campaign to let TikTok's algorithm find converters before narrowing targeting.",
          ],
        })
      );
    }
  }

  // CRE-003: High CPM with low CTR — expensive impressions failing to earn clicks
  const tiktokAdGroups = getRecordsByLevel(dataset, "TIKTOK", "adgroup");
  const adsWithCpmCtr = tiktokAds.filter(
    (r) => numberValue(r.cpm) > 0 && numberValue(r.ctr) > 0
  );
  if (adsWithCpmCtr.length >= 3) {
    const totalTikTokAdSpend = sumSpend(tiktokAds);
    const avgCpm =
      adsWithCpmCtr.reduce((acc, r) => acc + numberValue(r.cpm), 0) /
      adsWithCpmCtr.length;
    const highCpmLowCtr = adsWithCpmCtr.filter(
      (r) => numberValue(r.cpm) > avgCpm * 1.5 && numberValue(r.ctr) < 0.5
    );
    const highCpmLowCtrSpend = sumSpend(highCpmLowCtr);
    if (
      highCpmLowCtr.length > 0 &&
      totalTikTokAdSpend > 0 &&
      highCpmLowCtrSpend / totalTikTokAdSpend >= 0.15
    ) {
      findings.push(
        createFinding({
          ruleId: "CRE-003",
          platform: "TIKTOK",
          severity: "HIGH",
          category: "Creative Performance",
          title: "TikTok ads have high CPM but very low CTR — budget is burning on unclicked impressions",
          detail: `${highCpmLowCtr.length} ad(s) have CPM above 1.5× the account average ($${avgCpm.toFixed(2)}) but CTR below 0.5%. These ads are winning expensive auction slots but failing to generate clicks — a sign of mismatched creative or wrong audience.`,
          evidence: {
            highCpmLowCtrAds: highCpmLowCtr.length,
            accountAvgCpm: +avgCpm.toFixed(2),
            highCpmLowCtrSpend: Math.round(highCpmLowCtrSpend),
            examples: highCpmLowCtr.slice(0, 3).map((r) => ({
              name: r.name,
              cpm: numberValue(r.cpm).toFixed(2),
              ctr: numberValue(r.ctr).toFixed(2),
              spend: Math.round(numberValue(r.spend)),
            })),
          },
          estimatedImpact: `$${Math.round(highCpmLowCtrSpend).toLocaleString()} is on ads that cost above average to show but fail to earn clicks. Native-style creative typically improves CTR 2-3× and reduces effective CPM.`,
          fixSteps: [
            "Pause high-CPM, low-CTR ads and shift budget to your highest-CTR creatives.",
            "Review the hook (first 1-3 seconds): if it looks like an ad, TikTok users scroll past.",
            "Test UGC-style, native-format creative without branded intros or obvious sales pitches.",
            "Check audience targeting — high CPMs often indicate audiences that are too narrow or have inflated bids.",
          ],
        })
      );
    }
  }
};

const addDataQualityFindings = ({ audit, dataset, findings }) => {
  for (const platform of audit.selectedPlatforms) {
    const platformSummary = getPlatformSummary(dataset, platform);
    const readiness = audit.uploadReadiness?.platforms?.[platform];

    // Internal-consistency gate. A manual upload can be malformed — mismapped
    // columns, wrong units, misaligned rows — in ways that make the numbers
    // physically impossible. The clearest tell is clicks exceeding impressions
    // (you cannot click an ad that never showed). Trusting such data produces a
    // confident but garbage headline (a real upload claimed ~50% of a $2.8M
    // account was recoverable). When it trips, the report refuses to quantify.
    const di_impressions = numberValue(platformSummary.impressions);
    const di_clicks = numberValue(platformSummary.clicks);
    const di_spend = numberValue(platformSummary.spend);
    const integrityReasons = [];
    if (di_clicks > 0 && di_impressions === 0) {
      integrityReasons.push(
        `${Math.round(di_clicks)} clicks are recorded against zero impressions`
      );
    } else if (di_impressions > 0 && di_clicks > di_impressions * 1.05) {
      integrityReasons.push(
        `${Math.round(di_clicks)} clicks are recorded against only ${Math.round(di_impressions)} impressions`
      );
    }
    if (integrityReasons.length) {
      findings.push(
        createFinding({
          ruleId: "DATA-INTEGRITY-001",
          platform,
          severity: "CRITICAL",
          category: "Attribution & Reporting",
          title: `${PLATFORM_LABELS[platform]} data is internally inconsistent — the figures can't be trusted`,
          detail: `The uploaded data is physically impossible: ${integrityReasons.join("; and ")}. That almost always means a column was mismapped, the wrong units were exported, or rows are misaligned in the file. Any cost-per-result or recoverable figure derived from it would be misleading, so this audit does not put a number on the waste until the data is corrected.`,
          rootCause: "Source-data integrity failure — the core metrics do not reconcile against each other, so per-campaign cost and waste calculations cannot be trusted.",
          evidence: {
            impressions: Math.round(di_impressions),
            clicks: Math.round(di_clicks),
            spend: Math.round(di_spend),
            reasons: integrityReasons,
            dataIntegrityBroken: true,
            diagnostic: true,
            confidence: "high",
          },
          estimatedImpact:
            "No reliable money estimate can be produced from this file — re-export the report and re-upload before acting on this audit.",
          fixSteps: [
            "Re-export the report from the platform, checking that the impressions, clicks, spend, and conversions columns map correctly.",
            "Confirm the units (no thousands-separators read as values, correct currency/number formatting).",
            "Re-upload and re-run the audit — the figures should reconcile (clicks ≤ impressions) before any waste estimate is trusted.",
          ],
        })
      );
    }

    if (platformSummary.uploadedFiles > 0 && platformSummary.rowCount < 3) {
      findings.push(
        createFinding({
          ruleId: "DATA-002",
          platform,
          severity: "LOW",
          category: "Attribution & Reporting",
          title: `${PLATFORM_LABELS[platform]} audit has limited row coverage`,
          detail: "The audit can run, but findings are less confident with very few rows.",
          evidence: { rowCount: platformSummary.rowCount },
          estimatedImpact: "Recommendations should be treated as directional.",
          fixSteps: ["Upload additional report types or a fuller export when available."],
        })
      );
    }

    if (readiness?.missingReports?.length) {
      findings.push(
        createFinding({
          ruleId: "DATA-003",
          platform,
          severity: "MEDIUM",
          category: "Attribution & Reporting",
          title: `${PLATFORM_LABELS[platform]} audit is running with incomplete report coverage`,
          detail: "The audit can run in limited mode, but full confidence requires all required platform exports.",
          evidence: {
            missingReports: readiness.missingReports.map((report) => report.label),
            uploadedReports: readiness.uploadedReports.map((report) => report.label),
          },
          estimatedImpact: "Some rules may be skipped or less confident until all required reports are uploaded.",
          fixSteps: [
            "Upload the missing reports listed in the readiness checklist.",
            "Run the audit again after the checklist is complete.",
          ],
        })
      );
    }
  }
};

const addBusinessProfileFindings = ({ audit, dataset, findings }) => {
  const profile = getBusinessProfile(audit);
  if (!profile) return;

  const { sectionA, sectionB, sectionC } = profile;
  const platforms = audit.selectedPlatforms;
  const intakeCurrency = sectionA.currency || "USD";

  // ── B1: Pixel / conversion tag not installed ──────────────────────────────
  if (matchesWord(sectionB.pixelInstalled, ["no"])) {
    for (const platform of platforms) {
      findings.push(
        createFinding({
          ruleId: "BP-TRK-001",
          platform,
          severity: "CRITICAL",
          category: getTrackingCategory(platform),
          title: "Pixel / conversion tag is not installed or verified",
          detail:
            "Without a tracking pixel or conversion tag the ad platform has no signal to measure results or optimise bidding. This is the single most common root cause of wasted ad spend.",
          evidence: { B1: sectionB.pixelInstalled },
          estimatedImpact:
            "All smart-bidding strategies are running blind. Conversion reporting is inaccurate or empty.",
          fixSteps: [
            "Install the platform pixel on every page of your website.",
            "Verify the pixel fires on the primary conversion page using the platform's diagnostic tool.",
            "Set up at least one primary conversion event before running any spend.",
          ],
        })
      );
    }
  }

  // ── B2: Wrong conversion event ────────────────────────────────────────────
  if (
    matchesWord(sectionB.correctConversionEvent, ["no"]) ||
    text(sectionB.correctConversionEvent).includes("unsure")
  ) {
    for (const platform of platforms) {
      findings.push(
        createFinding({
          ruleId: "BP-TRK-002",
          platform,
          severity: "HIGH",
          category: getTrackingCategory(platform),
          title: "Conversion event may not match campaign objective",
          detail:
            "Optimising to the wrong event — for example Add to Cart instead of Purchase — teaches the bidding algorithm to target the wrong users. The algorithm maximises what you measure, not what you actually want.",
          evidence: { B2: sectionB.correctConversionEvent },
          estimatedImpact:
            "Bidding algorithms learn incorrect behaviour, systematically inflating your real CPA.",
          fixSteps: [
            "Audit active conversion events in each platform's settings.",
            "Ensure the primary event matches your objective: Sales → Purchase, Leads → Lead Submit.",
            "Demote mismatched events to 'Informational' or secondary status.",
          ],
        })
      );
    }
  }

  // ── B3: UTM inconsistency ─────────────────────────────────────────────────
  if (
    matchesWord(sectionB.utmConsistency, ["no"]) ||
    text(sectionB.utmConsistency).includes("inconsistently")
  ) {
    for (const platform of platforms) {
      findings.push(
        createFinding({
          ruleId: "BP-TRK-003",
          platform,
          severity: "MEDIUM",
          category: getAttributionCategory(platform),
          title: "UTM parameters are missing or inconsistent",
          detail:
            "Without consistent UTMs, GA4 and third-party analytics tools cannot validate platform-reported conversions. Platform-reported conversion numbers are frequently 20-40% inflated versus independently tracked data.",
          evidence: { B3: sectionB.utmConsistency },
          estimatedImpact:
            "Attribution data is unreliable. You cannot independently verify platform ROAS or conversion counts.",
          fixSteps: [
            "Define a UTM naming convention and document it in a shared template.",
            "Use a URL builder tool or spreadsheet for every ad link.",
            "Spot-check GA4 to confirm utm_source, utm_medium, and utm_campaign are populating.",
          ],
        })
      );
    }
  }

  // ── B5: No server-side tracking ───────────────────────────────────────────
  if (matchesWord(sectionB.serverSideTracking, ["no"])) {
    for (const platform of platforms) {
      findings.push(
        createFinding({
          ruleId: "BP-TRK-004",
          platform,
          severity: platform === "GOOGLE" ? "MEDIUM" : "HIGH",
          category: getTrackingCategory(platform),
          title: "Server-side tracking is not implemented",
          detail:
            "Post-iOS 14 browser privacy restrictions block 20-40% of pixel events. Server-side tracking (Meta CAPI, TikTok Events API, Google Enhanced Conversions) sends events directly from your server, restoring signal quality and allowing algorithms to optimise accurately.",
          evidence: { B5: sectionB.serverSideTracking },
          estimatedImpact:
            "Conversion undercounting suppresses algorithm optimisation. Reported ROAS is likely understated and campaign delivery is weaker than it could be.",
          fixSteps: [
            "Implement server-side events via your backend, Shopify integration, or a tag management server (e.g. Stape).",
            "Run pixel and server-side events in parallel to check event match quality.",
            "Verify event match quality score reaches 6+ in Meta Events Manager or equivalent.",
          ],
        })
      );
    }
  }

  // ── A3: Target CPA miss ───────────────────────────────────────────────────
  const targetCpa = numberValue(sectionA.targetCpa);
  if (targetCpa > 0) {
    for (const platform of platforms) {
      const summary = getPlatformSummary(dataset, platform);
      if (summary.spend > 0 && summary.conversions > 0) {
        // Trusted (anomaly-excluded) cost per result: the blended CPA is deflated
        // by fake-cheap conversions, which would HIDE a real target/CAC miss.
        const actualCpa = trustedAccountBaseline(dataset, platform);
        const ratio = actualCpa / targetCpa;
        if (ratio >= 1.5) {
          findings.push(
            createFinding({
              ruleId: "BP-PERF-001",
              platform,
              severity: ratio >= 2.5 ? "CRITICAL" : "HIGH",
              category: getBiddingCategory(platform),
              title: `${PLATFORM_LABELS[platform]} CPA is significantly above your declared target`,
              detail: `Your declared target CPA is ${fmtIntake(targetCpa, intakeCurrency)}. The actual CPA in this data is ${fmtIntake(actualCpa, intakeCurrency)} — ${ratio.toFixed(1)}× your goal. Every acquisition is costing far more than your business model planned for.`,
              evidence: {
                targetCpa,
                actualCpa: Math.round(actualCpa * 100) / 100,
                multiplier: +ratio.toFixed(1),
                totalSpend: Math.round(summary.spend),
                totalConversions: summary.conversions,
              },
              estimatedImpact: `At ${ratio.toFixed(1)}× your target, the cost of inaction compounds with every dollar of additional spend.`,
              fixSteps: [
                "Identify the top-spending campaigns and ad sets with CPA furthest above target — pause or cap them first.",
                "Review bidding strategy: check whether conversion volume is sufficient for stable smart bidding.",
                "Audit the conversion event being optimised — confirm it matches the intended action.",
                "Test landing page conversion rate improvements; ad-side CPA is often constrained by post-click performance.",
              ],
            })
          );
        }
      }
    }
  }

  // ── A4 + A5: Target ROAS miss (estimated from conversions × avg order value) ─
  const targetRoas = numberValue(sectionA.targetRoas);
  const avgOrderValue = numberValue(sectionA.avgOrderValue);
  if (targetRoas > 0 && avgOrderValue > 0) {
    for (const platform of platforms) {
      const summary = getPlatformSummary(dataset, platform);
      if (summary.spend > 0 && summary.conversions > 0) {
        const estimatedRevenue = summary.conversions * avgOrderValue;
        const estimatedRoas = estimatedRevenue / summary.spend;
        const ratio = estimatedRoas / targetRoas;
        if (ratio < 0.7) {
          findings.push(
            createFinding({
              ruleId: "BP-PERF-002",
              platform,
              severity: ratio < 0.4 ? "CRITICAL" : "HIGH",
              category: getBiddingCategory(platform),
              title: `${PLATFORM_LABELS[platform]} estimated ROAS is significantly below your target`,
              detail: `Using your declared average order value of $${avgOrderValue}, the estimated ROAS from this data is ${estimatedRoas.toFixed(2)}× against your target of ${targetRoas}×. The account is returning roughly ${Math.round(ratio * 100)}% of your intended return.`,
              evidence: {
                targetRoas,
                estimatedRoas: +estimatedRoas.toFixed(2),
                avgOrderValue,
                totalSpend: Math.round(summary.spend),
                estimatedRevenue: Math.round(estimatedRevenue),
                percentOfTarget: Math.round(ratio * 100),
              },
              estimatedImpact: `At ${estimatedRoas.toFixed(2)}× vs a ${targetRoas}× target, scaling spend in this state accelerates losses.`,
              fixSteps: [
                "Identify and pause the lowest-ROAS campaigns first.",
                "Shift budget toward the highest-ROAS ad sets or campaigns.",
                "Confirm the conversion event captures revenue value correctly.",
                "Assess whether landing page or offer quality is limiting post-click conversion.",
              ],
            })
          );
        }
      }
    }
  }

  // ── A2: Budget under-delivery ─────────────────────────────────────────────
  const monthlyBudget = numberValue(sectionA.monthlyBudget);
  if (monthlyBudget > 0) {
    const totalActualSpend = platforms.reduce(
      (acc, platform) => acc + getPlatformSummary(dataset, platform).spend,
      0
    );
    if (totalActualSpend > 0) {
      const deliveryRate = totalActualSpend / monthlyBudget;
      if (deliveryRate < 0.6) {
        const primaryPlatform =
          platforms.find((p) => getPlatformSummary(dataset, p).spend > 0) || platforms[0];
        findings.push(
          createFinding({
            ruleId: "BP-PERF-003",
            platform: primaryPlatform,
            severity: "MEDIUM",
            category: getBiddingCategory(primaryPlatform),
            title: "Ad spend is significantly below your declared monthly budget",
            detail: `Your declared monthly budget is ${fmtIntake(monthlyBudget, intakeCurrency)}. The data in this audit shows ${fmtIntake(Math.round(totalActualSpend), intakeCurrency)} in total spend — only ${Math.round(deliveryRate * 100)}% of your declared budget. Under-delivery at this scale usually indicates paused campaigns, disapproved ads, limited bids, or audiences that are too small.`,
            evidence: {
              declaredMonthlyBudget: monthlyBudget,
              actualSpendInData: Math.round(totalActualSpend),
              deliveryRatePercent: Math.round(deliveryRate * 100),
            },
            estimatedImpact:
              "Your declared growth targets are being missed by default, before any optimisation work begins.",
            fixSteps: [
              "Check for disapproved ads or policy violations limiting delivery.",
              "Review campaign and ad set statuses — identify everything paused.",
              "Audit bid and budget caps that may be artificially constraining spend.",
              "Broaden audience size if campaigns show 'audience too small' warnings.",
            ],
          })
        );
      }
    }
  }

  // ── A6 (blended CAC): profitability alert when CPA approaches or exceeds CAC ─
  const blendedCac = numberValue(sectionA.blendedCac);
  if (blendedCac > 0) {
    for (const platform of platforms) {
      const summary = getPlatformSummary(dataset, platform);
      if (summary.spend > 0 && summary.conversions > 0) {
        // Trusted (anomaly-excluded) cost per result: the blended CPA is deflated
        // by fake-cheap conversions, which would HIDE a real target/CAC miss.
        const actualCpa = trustedAccountBaseline(dataset, platform);
        const ratio = actualCpa / blendedCac;
        if (ratio >= 0.9) {
          const isOver = ratio >= 1.0;
          findings.push(
            createFinding({
              ruleId: "BP-PROF-001",
              platform,
              severity: isOver ? "CRITICAL" : "HIGH",
              category: getBiddingCategory(platform),
              title: isOver
                ? `${PLATFORM_LABELS[platform]} ad CPA equals or exceeds your blended CAC — account may be unprofitable`
                : `${PLATFORM_LABELS[platform]} ad CPA is approaching your blended CAC`,
              detail: isOver
                ? `Your declared blended CAC is $${blendedCac}. The current ${PLATFORM_LABELS[platform]} CPA is $${actualCpa.toFixed(2)}, which equals or exceeds what you can sustainably pay per customer across all channels. At this CPA, paid advertising is likely destroying business margin.`
                : `Your declared blended CAC is $${blendedCac}. The current ${PLATFORM_LABELS[platform]} CPA is $${actualCpa.toFixed(2)} — ${Math.round(ratio * 100)}% of your maximum sustainable acquisition cost. A minor performance dip will push the account into unprofitable territory.`,
              evidence: {
                blendedCac,
                actualCpa: Math.round(actualCpa * 100) / 100,
                percentOfCac: Math.round(ratio * 100),
              },
              estimatedImpact: isOver
                ? "Every additional dollar of spend at this CPA deepens the loss per customer."
                : "There is very little headroom before ads become unprofitable.",
              fixSteps: [
                "Immediately pause highest-CPA campaigns and ad sets.",
                "Identify whether the issue is conversion rate (ad/landing page) or CPM efficiency (audience/creative).",
                "Set automated rules to pause ad sets whose 7-day CPA exceeds your blended CAC.",
                "Re-evaluate whether your declared CAC still reflects current business unit economics.",
              ],
            })
          );
        }
      }
    }
  }

  // ── C1 (bestEverCpa): performance regression vs historical best ───────────
  const bestEverCpa = numberValue(sectionC.bestEverCpa);
  if (bestEverCpa > 0) {
    for (const platform of platforms) {
      const summary = getPlatformSummary(dataset, platform);
      if (summary.spend > 0 && summary.conversions > 0) {
        // Trusted (anomaly-excluded) cost per result: the blended CPA is deflated
        // by fake-cheap conversions, which would HIDE a real target/CAC miss.
        const actualCpa = trustedAccountBaseline(dataset, platform);
        if (actualCpa > bestEverCpa * 2) {
          findings.push(
            createFinding({
              ruleId: "BP-BENCH-001",
              platform,
              severity: "HIGH",
              category: getBiddingCategory(platform),
              title: `${PLATFORM_LABELS[platform]} CPA is more than 2× your declared best-ever performance`,
              detail: `Your declared best-ever CPA is $${bestEverCpa}. The current ${PLATFORM_LABELS[platform]} CPA is $${actualCpa.toFixed(2)} — ${(actualCpa / bestEverCpa).toFixed(1)}× worse. This level of regression suggests a structural change: audience saturation, creative fatigue, a tracking break, or a platform algorithm shift.`,
              evidence: {
                bestEverCpa,
                actualCpa: Math.round(actualCpa * 100) / 100,
                regressionMultiplier: +(actualCpa / bestEverCpa).toFixed(1),
              },
              estimatedImpact:
                "This level of regression typically requires structural investigation, not just incremental optimisation.",
              fixSteps: [
                "Compare current account structure to the period when best CPA was achieved.",
                "Check for tracking breaks that may be inflating the measured CPA.",
                "Test a simplified structure (fewer campaigns, tighter audiences) to see if performance recovers.",
                "Audit creative: compare current CTR and hook rate to historical benchmarks.",
              ],
            })
          );
        }
      }
    }
  }

  // ── C5: Low landing page conversion rate ─────────────────────────────────
  const landingPageCvr = numberValue(sectionC.landingPageConversionRate);
  if (landingPageCvr > 0 && landingPageCvr < 1.5) {
    for (const platform of platforms) {
      findings.push(
        createFinding({
          ruleId: "BP-BENCH-002",
          platform,
          severity: "HIGH",
          category: getAttributionCategory(platform),
          title: "Landing page conversion rate is low — ad CPA improvements are limited",
          detail: `Your declared landing page conversion rate is ${landingPageCvr}%. At this rate, even ads with excellent CTR and targeting will produce high CPAs because most ad traffic does not convert. Improving the landing page typically delivers faster CPA reductions than optimising the ads themselves.`,
          evidence: { landingPageConversionRate: landingPageCvr },
          estimatedImpact:
            "A 1% improvement in landing page CVR often halves CPA more effectively than months of ad-level optimisation.",
          fixSteps: [
            "Run a CRO audit on the primary landing page — check load speed, above-fold clarity, and CTA prominence.",
            "A/B test a simplified version of the page with a single, clear call to action.",
            "Ensure ad creative messaging matches landing page messaging exactly (message match).",
            "Check page speed with Google PageSpeed Insights — mobile load time above 3s cuts conversion rate significantly.",
          ],
        })
      );
    }
  }
};

const addBenchmarkFindings = ({ audit, dataset, findings }) => {
  const bp = getBusinessProfile(audit);
  // Declared business type wins; when absent/"Other", infer it from the account's
  // own result mix so benchmarks still fit instead of falling back to generic.
  const { businessType } = resolveBusinessType(audit, dataset);

  for (const platform of audit.selectedPlatforms) {
    const summary = getPlatformSummary(dataset, platform);
    if (!summary.spend || summary.spend <= 0) continue;

    // CTR benchmark — all three platforms. Use the anomaly-excluded CTR so a
    // tracking anomaly's fake clicks don't make a struggling account read "Strong"
    // against the industry bar (blended 6% vs genuine ~2.4%). For Google, benchmark
    // against the account's DOMINANT NETWORK (Search vs Display/Video/Shopping/PMax)
    // so a low-CTR Display account isn't branded "critically below" a Search bar.
    const googleNetwork = platform === "GOOGLE" ? resolveGoogleNetwork(dataset) : null;
    const networkLabel = googleNetwork ? googleNetwork.replace("_", " ").toLowerCase() : null;
    // Only non-Search networks get a disclosing suffix (the business-type table is
    // already the Search benchmark, so "Search network" is redundant).
    const netSuffix =
      googleNetwork && googleNetwork !== "SEARCH" ? ` on the ${networkLabel} network` : "";
    const ctrBenchmark = getBenchmark("ctr", platform, businessType, googleNetwork);
    const genMetrics = genuineAccountMetrics(dataset, platform);
    const ctrImpressions = genMetrics.hasAnomaly ? genMetrics.impressions : summary.impressions;
    const ctrClicks = genMetrics.hasAnomaly ? genMetrics.clicks : summary.clicks;
    if (ctrBenchmark && ctrImpressions > 5000) {
      const actualCtr = (ctrClicks / ctrImpressions) * 100;
      // Significance: the CTR estimate is reliable above the impression gate.
      const ctrCi = wilsonInterval(ctrClicks, ctrImpressions);
      const ctrSignificance = {
        minSamplePassed: ctrImpressions >= 1000,
        confidence: ctrImpressions >= 5000 ? "high" : "medium",
        sampleNote: `CTR measured over ${ctrImpressions.toLocaleString()} ${genMetrics.hasAnomaly ? "genuine (anomaly-excluded) " : ""}impressions`,
        ctrConfidenceInterval: ctrCi
          ? {
              lowPct: +(ctrCi.low * 100).toFixed(3),
              highPct: +(ctrCi.high * 100).toFixed(3),
            }
          : null,
      };
      if (actualCtr < ctrBenchmark.danger) {
        findings.push(
          createFinding({
            ruleId: "BENCH-CTR-001",
            platform,
            severity: "HIGH",
            category: platform === "GOOGLE" ? "Quality Score & Relevance" : "Creative Performance",
            title: `${PLATFORM_LABELS[platform]} CTR is critically below the ${businessType}${netSuffix} benchmark`,
            detail: `Your ${PLATFORM_LABELS[platform]} account CTR is ${actualCtr.toFixed(2)}% against a benchmark of ${ctrBenchmark.good}% for ${businessType}${netSuffix}. A CTR this far below benchmark (danger threshold: ${ctrBenchmark.danger}%) indicates poor creative relevance, weak ad copy, or significant audience-creative mismatch. At your current spend of $${Math.round(summary.spend).toLocaleString()}, you are paying for impressions at an industry-trailing efficiency.`,
            evidence: {
              actualCtr: +actualCtr.toFixed(2),
              benchmarkGood: ctrBenchmark.good,
              benchmarkDanger: ctrBenchmark.danger,
              businessType,
              network: googleNetwork,
              impressions: summary.impressions,
              // A CTR-vs-benchmark gap is a RELATIVE efficiency signal (a creative
              // problem), not cuttable spend — it must never inject a recoverable
              // dollar. Without this, the reconciler scraped the account spend
              // quoted in the impact text and booked half of it as "recoverable"
              // (a 2.79M-spend account hit the 50% cap on this finding alone).
              advisory: true,
              ...ctrSignificance,
            },
            estimatedImpact: `Closing the gap from ${actualCtr.toFixed(2)}% to the ${ctrBenchmark.good}% benchmark would deliver more clicks at the same CPM — a lower effective CPC, not a cash refund.`,
            fixSteps: [
              `Test 3–5 new creative concepts with stronger hooks — the ${businessType} benchmark on ${PLATFORM_LABELS[platform]} is ${ctrBenchmark.good}% CTR.`,
              "Audit top-spending ads and pause anything with CTR below half the benchmark.",
              "Tighten audience targeting to improve relevance.",
              platform === "GOOGLE"
                ? "Review ad copy for keyword-to-headline match and strengthen ad extensions."
                : "Test video formats vs. static images — video typically drives higher CTR on this platform.",
            ],
          })
        );
      } else if (actualCtr < ctrBenchmark.warning) {
        findings.push(
          createFinding({
            ruleId: "BENCH-CTR-001",
            platform,
            severity: "MEDIUM",
            category: platform === "GOOGLE" ? "Quality Score & Relevance" : "Creative Performance",
            title: `${PLATFORM_LABELS[platform]} CTR is below the ${businessType}${netSuffix} benchmark`,
            detail: `Your ${PLATFORM_LABELS[platform]} account CTR is ${actualCtr.toFixed(2)}%. The benchmark for ${businessType}${netSuffix ? netSuffix : ` on ${PLATFORM_LABELS[platform]}`} is ${ctrBenchmark.good}%. You are in the warning zone (below ${ctrBenchmark.warning}%) — creative refresh and audience refinement will improve downstream CPA.`,
            evidence: {
              actualCtr: +actualCtr.toFixed(2),
              benchmarkGood: ctrBenchmark.good,
              benchmarkWarning: ctrBenchmark.warning,
              businessType,
              network: googleNetwork,
              impressions: summary.impressions,
              advisory: true, // relative-efficiency signal, not recoverable spend
              ...ctrSignificance,
            },
            estimatedImpact: `Reaching the ${ctrBenchmark.good}% benchmark CTR would reduce your effective CPC without increasing spend.`,
            fixSteps: [
              `Target ${ctrBenchmark.good}% CTR for ${businessType} accounts on ${PLATFORM_LABELS[platform]}.`,
              "Rotate in fresh creative — pause ads running more than 30 days with declining CTR.",
              "Test new audience segments that may be more receptive to your offer.",
            ],
          })
        );
      }
    }

    // CPM benchmark — Meta and TikTok only.
    //
    // INDUSTRY_BENCHMARKS.cpm thresholds are absolute money (USD). Applying them
    // to a non-USD account is invalid: a PKR account at ~314 PKR CPM compared
    // against a USD danger threshold of 60 always reads "critically above" and
    // fabricates a nonsensical "PKR 20 CPM target / PKR 11,636 overspend" — the
    // exact false finding that got a live report rejected. CTR (a ratio) is
    // currency-independent and still fires; CPM is gated to USD (or unknown,
    // which we treat as the USD basis) so we never assert a benchmark we can't
    // validate against the account's currency.
    const cpmCurrency = getReportCurrency(dataset, platform);
    const cpmBenchmarkApplies = !cpmCurrency || String(cpmCurrency).toUpperCase() === "USD";
    const cpmBenchmark = cpmBenchmarkApplies ? getBenchmark("cpm", platform, businessType) : null;
    const cpmSpend = genMetrics.hasAnomaly ? genMetrics.spend : summary.spend;
    if (cpmBenchmark && ctrImpressions > 5000) {
      const actualCpm = (cpmSpend / ctrImpressions) * 1000;
      const overVsGood = Math.round((actualCpm - cpmBenchmark.good) / 1000 * ctrImpressions);
      if (actualCpm > cpmBenchmark.danger) {
        findings.push(
          createFinding({
            ruleId: "BENCH-CPM-001",
            platform,
            severity: "HIGH",
            category: "Audience Strategy",
            title: `${PLATFORM_LABELS[platform]} CPM is critically above the ${businessType} industry benchmark`,
            detail: `Your ${PLATFORM_LABELS[platform]} CPM is $${actualCpm.toFixed(2)}, which exceeds the danger threshold of $${cpmBenchmark.danger} for ${businessType} accounts. You are overpaying for impressions by an estimated $${overVsGood.toLocaleString()} compared to benchmark-level buying ($${cpmBenchmark.good} CPM target).`,
            evidence: {
              actualCpm: +actualCpm.toFixed(2),
              benchmarkGood: cpmBenchmark.good,
              benchmarkDanger: cpmBenchmark.danger,
              businessType,
              totalSpend: Math.round(summary.spend),
              impressions: summary.impressions,
              estimatedOverspend: overVsGood,
              // CPM overpayment is a reach-efficiency signal, not recoverable cash
              // (lowering CPM extends reach at the same spend; it doesn't refund
              // budget). Never let the overspend figure be booked as recoverable.
              advisory: true,
            },
            estimatedImpact: `Overpaying an estimated $${overVsGood.toLocaleString()} vs. benchmark CPM efficiency at your current impression volume — lowering CPM extends reach at the same spend, it does not refund budget.`,
            fixSteps: [
              "Broaden targeting to access cheaper inventory — narrow audiences drive CPM spikes.",
              "Test interest-based and lookalike audiences alongside retargeting (retargeting pools carry premium CPMs).",
              "Review campaign objective — conversion objectives have higher CPMs than traffic or reach objectives.",
              "Audit ad set overlap — overlapping audiences bid against each other and inflate CPM.",
            ],
          })
        );
      } else if (actualCpm > cpmBenchmark.warning) {
        findings.push(
          createFinding({
            ruleId: "BENCH-CPM-001",
            platform,
            severity: "MEDIUM",
            category: "Audience Strategy",
            title: `${PLATFORM_LABELS[platform]} CPM is above the ${businessType} industry benchmark`,
            detail: `Your ${PLATFORM_LABELS[platform]} CPM is $${actualCpm.toFixed(2)}, above the recommended ceiling of $${cpmBenchmark.warning} for ${businessType}. The ideal target is $${cpmBenchmark.good}. This indicates audience or bidding inefficiency.`,
            evidence: {
              actualCpm: +actualCpm.toFixed(2),
              benchmarkGood: cpmBenchmark.good,
              benchmarkWarning: cpmBenchmark.warning,
              businessType,
              advisory: true, // reach-efficiency signal, not recoverable spend
            },
            estimatedImpact: `Reducing CPM to the $${cpmBenchmark.good} benchmark would extend your reach significantly at the same spend.`,
            fixSteps: [
              "Test broader audiences to access cheaper inventory.",
              "Use the Audience Overlap tool to consolidate competing ad sets.",
              "Test traffic or reach objectives which typically access cheaper inventory than conversion objectives.",
            ],
          })
        );
      }
    }

    // ── DIAG-CPA-001: why is CPA over target? (decomposition) ──────────────
    // Only fires when the customer declared a target CPA and the account has a
    // material, statistically-meaningful sample. Attributes the overage to
    // click cost (low CTR) vs post-click conversion (healthy CTR).
    const resolvedTarget = resolveTargetCpa(audit, dataset, platform);
    const targetCpa = resolvedTarget.value;
    const targetInferred = resolvedTarget.source === "inferred";
    // Stamp an inferred target on the summary so the report scorecard scores CPA
    // against the same number (and can disclose it as inferred, not declared).
    if (targetInferred) {
      summary.inferredTargetCpa = targetCpa;
    }
    const conversions = numberValue(summary.conversions);
    if (targetCpa > 0 && conversions > 0) {
      // Use the anomaly-quarantined cost per result so this matches the scorecard
      // CPA (the true ~PKR 115), not the fake-cheap blended PKR 53 the WhatsApp
      // taps create — otherwise the report shows two different "actual CPA"s.
      const actualCpa = +trustedAccountBaseline(dataset, platform).toFixed(2);
      // CTR drives the post-click-vs-click diagnosis, so it must also exclude the
      // anomaly's fake clicks — the blended 6% CTR is inflated; the genuine read is
      // ~2.4%, which can flip "clicks are healthy" to "click cost is the driver".
      const gen = genuineAccountMetrics(dataset, platform);
      const actualCtr =
        gen.hasAnomaly && gen.ctr != null
          ? +gen.ctr.toFixed(2)
          : summary.impressions > 0
            ? +((summary.clicks / summary.impressions) * 100).toFixed(2)
            : null;
      const gate = gateFinding({
        spend: summary.spend,
        clicks: summary.clicks,
        conversions,
        minSpend: 200,
        minClicks: 100,
        minConversions: 10,
        materialSpend: 1000,
      });
      const diagnosis = diagnoseCpaDriver({
        actualCpa,
        targetCpa,
        actualCtr,
        benchmarkCtrWarning: ctrBenchmark?.warning ?? null,
        benchmarkCtrGood: ctrBenchmark?.good ?? null,
      });

      if (gate.surface && diagnosis && diagnosis.dominantDriver !== "unknown") {
        const driverLabel =
          diagnosis.dominantDriver === "conversion_rate"
            ? "weak post-click conversion, not expensive clicks"
            : "expensive, low-relevance clicks";
        // Be honest about where the target came from — an inferred target is the
        // campaigns' own tCPA goal, NOT a number the advertiser gave us.
        const targetPhrase = targetInferred
          ? `your campaigns' own ${fmtIntake(targetCpa, bp?.sectionA?.currency)} Target-CPA goal (no account target was set in intake)`
          : `your ${fmtIntake(targetCpa, bp?.sectionA?.currency)} target`;
        // This diagnosis supersedes the generic BP-PERF-001 "CPA above target"
        // alert on the same platform — it says the same thing AND explains the
        // driver. Drop the redundant alert so the report states it once.
        const dupIdx = findings.findIndex(
          (f) => f.ruleId === "BP-PERF-001" && f.platform === platform
        );
        if (dupIdx >= 0) findings.splice(dupIdx, 1);
        findings.push(
          createFinding({
            ruleId: "DIAG-CPA-001",
            platform,
            severity: gate.confidence === "high" ? "HIGH" : "MEDIUM",
            category: getBiddingCategory(platform),
            title: `${PLATFORM_LABELS[platform]} CPA is over target — driven by ${driverLabel}`,
            detail: diagnosis.explanationFacts.join(" "),
            evidence: {
              metric: diagnosis.metric,
              actualCpa,
              targetCpa,
              targetSource: resolvedTarget.source,
              dominantDriver: diagnosis.dominantDriver,
              driverDeltas: diagnosis.driverDeltas,
              explanationFacts: diagnosis.explanationFacts,
              // Diagnostic finding: it explains WHY CPA misses target. It carries
              // no recoverable-dollar figure (the recoverable is already counted
              // by the per-campaign/segment findings), so the report must not
              // parse a money figure out of its narrative target reference.
              diagnostic: true,
              confidence: gate.confidence,
              minSamplePassed: gate.passed,
              sampleNote: gate.sampleNote,
            },
            estimatedImpact:
              diagnosis.dominantDriver === "conversion_rate"
                ? `CPA is ${diagnosis.driverDeltas.cpaOverTargetPct}% over ${targetPhrase}. Because CTR is healthy, the highest-leverage fix is post-click: landing page, offer, and conversion tracking — not bids or creative.`
                : `CPA is ${diagnosis.driverDeltas.cpaOverTargetPct}% over ${targetPhrase}, and low CTR means you are buying expensive, low-relevance clicks. Fix creative/targeting relevance before touching bids.`,
            fixSteps:
              diagnosis.dominantDriver === "conversion_rate"
                ? [
                    "Audit the landing page: load speed, message match, and friction in the conversion step.",
                    "Verify conversion tracking is firing correctly — under-counting inflates CPA.",
                    "Test offer / CTA changes before increasing bids.",
                  ]
                : [
                    "Refresh creative and tighten targeting to lift CTR toward benchmark.",
                    "Pause the lowest-CTR ads carrying meaningful spend.",
                    "Re-check CPA after CTR improves — click cost should fall.",
                  ],
          })
        );
      }
    }
  }
};

const addOpportunityFindings = ({ audit, dataset, findings }) => {
  const bp = getBusinessProfile(audit);
  const sectionA = bp?.sectionA || {};
  const businessType = sectionA.businessType || "Other";
  const monthlyBudget = numberValue(sectionA.monthlyBudget);

  // OPP-001: No Google brand campaign
  if (audit.selectedPlatforms.includes("GOOGLE")) {
    const campaigns = getRecordsByLevel(dataset, "GOOGLE", "campaign");
    if (campaigns.length > 0) {
      const hasBrandCampaign = campaigns.some((c) =>
        text(c.name).includes("brand") ||
        text(c.name).includes("branded") ||
        text(c.name).includes("trademark")
      );
      if (!hasBrandCampaign) {
        findings.push(
          createFinding({
            ruleId: "OPP-001",
            platform: "GOOGLE",
            severity: "MEDIUM",
            category: "Campaign Structure",
            title: "No Google brand campaign detected — brand traffic is unprotected",
            detail: `None of your ${campaigns.length} Google campaign(s) appear to target branded keywords. Without a dedicated brand campaign, competitors can bid on your brand name and capture high-intent searches that should convert at a fraction of your non-brand CPA. Brand campaigns typically achieve 5–10× better CTR and ROAS than non-brand.`,
            evidence: { campaignCount: campaigns.length, brandCampaignDetected: false },
            estimatedImpact: "Unprotected brand searches allow competitors to capture your highest-intent traffic at no cost to you.",
            fixSteps: [
              "Create a dedicated branded keyword campaign with exact and phrase match variants of your brand name.",
              "Set bids high enough to maintain brand impression share above 90%.",
              "Add competitor brand terms to a separate observation campaign to monitor intent traffic.",
            ],
          })
        );
      }
    }
  }

  // OPP-002: eCommerce Google with conversions but zero conversion value
  if (audit.selectedPlatforms.includes("GOOGLE") && businessType === "eCommerce") {
    const campaigns = getRecordsByLevel(dataset, "GOOGLE", "campaign");
    if (campaigns.length > 0) {
      const totalConvValue = campaigns.reduce((sum, c) => sum + numberValue(c.convValue), 0);
      const totalConversions = campaigns.reduce((sum, c) => sum + numberValue(c.conversions), 0);
      const totalSpend = campaigns.reduce((sum, c) => sum + numberValue(c.spend), 0);
      if (totalConversions > 0 && totalConvValue === 0) {
        findings.push(
          createFinding({
            ruleId: "OPP-002",
            platform: "GOOGLE",
            severity: "HIGH",
            category: "Conversion Tracking Setup",
            title: "eCommerce account records conversions but no conversion value — ROAS bidding is impossible",
            detail: `Your Google account recorded ${Math.round(totalConversions)} conversions with $0 in conversion value across $${Math.round(totalSpend).toLocaleString()} in spend. Without revenue data flowing into Google Ads, Smart Bidding cannot optimise for ROAS — it defaults to CPA-style optimisation with no understanding of order value. This is a critical gap for any eCommerce account.`,
            evidence: {
              totalConversions: Math.round(totalConversions),
              totalConvValue: 0,
              totalSpend: Math.round(totalSpend),
            },
            estimatedImpact: "Smart Bidding is optimising for count, not revenue — enabling value-based bidding typically improves ROAS 15–30% for eCommerce accounts.",
            fixSteps: [
              "Implement conversion value tracking — pass the transaction revenue amount for every purchase conversion.",
              "Verify the Google Ads purchase tag fires with the correct value parameter on the order confirmation page.",
              "Once value data has 30+ days of history, switch the primary bid strategy to Target ROAS.",
            ],
          })
        );
      }
    }
  }

  // OPP-003: eCommerce Google with no Shopping or Performance Max campaign
  if (audit.selectedPlatforms.includes("GOOGLE") && businessType === "eCommerce") {
    const campaigns = getRecordsByLevel(dataset, "GOOGLE", "campaign");
    if (campaigns.length > 0) {
      const hasShoppingOrPmax = campaigns.some((c) => {
        const t = text(c.type);
        const n = text(c.name);
        return (
          t.includes("shopping") || t.includes("performance_max") || t.includes("pmax") ||
          n.includes("shopping") || n.includes("pmax") || n.includes("performance max")
        );
      });
      if (!hasShoppingOrPmax) {
        findings.push(
          createFinding({
            ruleId: "OPP-003",
            platform: "GOOGLE",
            severity: "MEDIUM",
            category: "Campaign Structure",
            title: "eCommerce account has no Shopping or Performance Max campaign — major revenue channel missing",
            detail: `Your ${campaigns.length} Google campaign(s) appear entirely Search-based — no Shopping or Performance Max campaigns are detected. For eCommerce, Shopping and PMax campaigns typically drive 40–60% of Google revenue because they show product images and prices directly in search results, capturing high-purchase-intent shoppers at the moment of decision.`,
            evidence: { campaignCount: campaigns.length, shoppingOrPmaxDetected: false },
            estimatedImpact: "Missing Shopping/PMax campaigns leaves a primary eCommerce revenue channel completely untapped.",
            fixSteps: [
              "Ensure your Google Merchant Center feed is verified and approved.",
              "Create a Performance Max campaign with your product feed as the primary asset.",
              "Allocate 15–20% of total Search budget to the initial PMax test.",
              "Review PMax impression share and search term reports after 2–4 weeks.",
            ],
          })
        );
      }
    }
  }

  // OPP-004: Single-platform account with budget sufficient for expansion
  if (audit.selectedPlatforms.length === 1 && monthlyBudget >= 3000) {
    const currentPlatform = audit.selectedPlatforms[0];
    const suggestedPlatform =
      currentPlatform === "META" ? "Google" : currentPlatform === "GOOGLE" ? "Meta" : "Meta";
    findings.push(
      createFinding({
        ruleId: "OPP-004",
        platform: currentPlatform,
        severity: "LOW",
        category: "Campaign Structure",
        title: `Account runs on one platform at ${fmtIntake(monthlyBudget, sectionA.currency)}/month — ${suggestedPlatform} expansion is a growth lever`,
        detail: `With a declared monthly budget of ${fmtIntake(monthlyBudget, sectionA.currency)}, this account has the scale to support multi-platform advertising. Single-platform accounts at this budget are exposed to auction volatility and miss audiences only accessible on other platforms.`,
        evidence: { monthlyBudget, currentPlatform, suggestedPlatform },
        estimatedImpact: `Allocating 15–20% of budget to ${suggestedPlatform} diversifies risk and opens new acquisition channels.`,
        fixSteps: [
          `Research ${suggestedPlatform} audience overlap with your current ${PLATFORM_LABELS[currentPlatform]} buyers.`,
          `Start with a 30-day test at ${fmtIntake(Math.round(monthlyBudget * 0.15), sectionA.currency)}/month on ${suggestedPlatform} — retargeting your existing customer list first.`,
          "Set clear ROAS/CPA targets before launching the test so you have an objective exit criterion.",
        ],
      })
    );
  }

  // OPP-005: Meta with no upper-funnel campaigns (all conversion-objective)
  if (audit.selectedPlatforms.includes("META")) {
    const campaigns = getRecordsByLevel(dataset, "META", "campaign");
    if (campaigns.length >= 3) {
      const upperFunnelObjectives = ["awareness", "reach", "traffic", "engagement", "video_views", "video views"];
      const hasUpperFunnel = campaigns.some((c) =>
        upperFunnelObjectives.some((obj) => text(c.objective).includes(obj))
      );
      const allConversion = campaigns.every((c) => {
        const obj = text(c.objective);
        return obj.includes("conversion") || obj.includes("outcome_sales") || obj.includes("lead") || obj.includes("purchase");
      });
      if (!hasUpperFunnel && allConversion) {
        const totalSpend = sumSpend(campaigns);
        findings.push(
          createFinding({
            ruleId: "OPP-005",
            platform: "META",
            severity: "MEDIUM",
            category: "Campaign Structure",
            title: "All Meta campaigns are conversion-objective — no upper-funnel spend is building future demand",
            detail: `All ${campaigns.length} Meta campaigns run conversion or lead objectives ($${Math.round(totalSpend).toLocaleString()} in detected spend). The account relies entirely on existing market awareness. As audiences saturate, CPAs rise because no fresh awareness traffic feeds the funnel. Retargeting pools shrink and prospecting CPAs climb without upper-funnel investment refreshing them.`,
            evidence: {
              campaignCount: campaigns.length,
              totalSpend: Math.round(totalSpend),
              upperFunnelCampaigns: 0,
            },
            estimatedImpact: "CPAs will continue rising as current audiences saturate without upper-funnel campaigns refreshing the prospecting pool.",
            fixSteps: [
              "Allocate 10–15% of Meta spend to a Reach or Traffic campaign targeting a broad cold audience.",
              "Use this upper-funnel traffic as a retargeting audience for conversion campaigns (30/60/90-day windows).",
              "Test video creative in the awareness campaign — cost-efficient for reach and builds brand recognition.",
            ],
          })
        );
      }
    }
  }

  // OPP-006: High-QS Google keywords with minimal spend (undertapped efficiency)
  if (audit.selectedPlatforms.includes("GOOGLE")) {
    const keywords = getRecordsByLevel(dataset, "GOOGLE", "keyword");
    if (keywords.length > 0) {
      const highQsUnderused = keywords.filter((kw) => {
        const qs = numberValue(kw.qualityScore);
        const clicks = numberValue(kw.clicks);
        const spend = numberValue(kw.spend);
        return qs >= 8 && clicks < 30 && spend < 100;
      });
      if (highQsUnderused.length >= 2) {
        findings.push(
          createFinding({
            ruleId: "OPP-006",
            platform: "GOOGLE",
            severity: "LOW",
            category: "Keyword Strategy",
            title: `${highQsUnderused.length} high-Quality Score keywords are under-budgeted — efficient clicks are being left on the table`,
            detail: `${highQsUnderused.length} keyword(s) have a Quality Score of 8 or above but fewer than 30 clicks and under $100 in spend. High-QS keywords get cheaper CPCs and better ad positions — Google rewards relevance with lower auction prices. Constraining these keywords while spending on lower-QS terms is backwards budget allocation.`,
            evidence: {
              highQsUnderused: highQsUnderused.length,
              examples: highQsUnderused.slice(0, 3).map((kw) => ({
                keyword: kw.keyword,
                qualityScore: kw.qualityScore,
                clicks: kw.clicks,
                spend: kw.spend,
              })),
            },
            estimatedImpact: `Scaling budget to high-QS keywords delivers more clicks at lower CPC than your current keyword mix.`,
            fixSteps: [
              `Identify which campaigns contain the ${highQsUnderused.length} high-QS, low-spend keywords.`,
              "Increase bids or campaign budgets to capture more impression share for these keywords.",
              "Check whether these campaigns are losing impression share to budget constraints.",
            ],
          })
        );
      }
    }
  }
};

const addCompoundFindings = ({ audit, findings }) => {
  // COMP-TRK-001: Three or more tracking failures on the same platform — compound critical
  for (const platform of audit.selectedPlatforms) {
    const trackingFindings = findings.filter(
      (f) =>
        f.platform === platform &&
        (f.ruleId.startsWith("BP-TRK") ||
          f.ruleId.startsWith("TRK") ||
          f.category === getTrackingCategory(platform))
    );

    if (trackingFindings.length >= 3) {
      const alreadyHasCompound = findings.some(
        (f) => f.ruleId === "COMP-TRK-001" && f.platform === platform
      );
      if (!alreadyHasCompound) {
        findings.push(
          createFinding({
            ruleId: "COMP-TRK-001",
            platform,
            severity: "CRITICAL",
            category: getTrackingCategory(platform),
            title: `${PLATFORM_LABELS[platform]} has ${trackingFindings.length} simultaneous tracking failures — all performance data is unreliable`,
            detail: `The audit detected ${trackingFindings.length} independent tracking issues on ${PLATFORM_LABELS[platform]}: ${trackingFindings.map((f) => f.title).join("; ")}. When multiple tracking layers fail simultaneously, every CPA, ROAS, and conversion metric in this report is unreliable. The algorithm is optimising toward false signals — you may be scaling campaigns that are losing money and cutting campaigns that are actually profitable.`,
            evidence: {
              trackingFindingCount: trackingFindings.length,
              affectedRuleIds: trackingFindings.map((f) => f.ruleId),
            },
            estimatedImpact: "CRITICAL: All optimisation decisions on this platform are being made on corrupted data. Fix tracking before acting on any other finding.",
            fixSteps: [
              `Resolve each tracking finding in this report before taking any other action on ${PLATFORM_LABELS[platform]}.`,
              "Install the platform's browser debugging extension and verify events fire on your key conversion pages.",
              "Run a traffic test with UTM parameters and verify the full funnel appears in your analytics.",
              "Consider a dedicated tracking audit before making any bid strategy or budget changes.",
            ],
          })
        );
      }
    }
  }
};

const SEGMENT_CATEGORY = {
  META: "Audience Strategy",
  GOOGLE: "Audience & Attribution",
  TIKTOK: "Audience Strategy",
};

const SEGMENT_WASTE_MIN = 50; // floor before we surface a segment finding

const SEGMENT_MAX_FINDINGS_PER_PLATFORM = 2; // top N dimensions by waste

/**
 * SEG-WASTE-001 — dimension-level waste detection.
 *
 * Reads `dataset.data.platforms.<PLATFORM>.byDimension` (age/gender/placement/
 * device/hour/region) when present, computes per-segment CPA vs the platform
 * baseline, and surfaces the worst significant segment PER dimension — capped at
 * the top N dimensions by waste. Per-dimension (rather than a single overall
 * worst) so, e.g., Meta placement waste — Audience Network is the classic leak —
 * is not hidden when a demographic or day-of-week segment wastes marginally more.
 *
 * Safe by construction: when no breakdown data exists (CSV-only audits, or
 * accounts where Meta returned no breakdowns), it emits nothing.
 */
const addSegmentFindings = ({ audit, dataset, findings }) => {
  for (const platform of audit.selectedPlatforms) {
    const platformData = dataset?.data?.platforms?.[platform];
    const byDimension = platformData?.byDimension;
    if (!byDimension || Object.keys(byDimension).length === 0) continue;

    // On a Meta account that mixes click-tier and conversion-tier campaigns, the
    // per-segment conversion count is contaminated (clicks the breakdown can't
    // attribute), so a segment-CPA waste claim would be confidently wrong. Stand
    // down for Meta here rather than over-flag; other rules still cover it.
    if (platform === "META" && metaBreakdownFamiliesAreMixed(dataset)) continue;

    const summary = getPlatformSummary(dataset, platform);
    // Judge segments against the anomaly-quarantined baseline. If the blended
    // baseline is collapsed by fake-cheap conversions, comparing a placement/age
    // segment to it brands healthy segments (the Facebook workhorse, the core age
    // band) as "waste" — exactly the contradiction where the headline says the
    // true baseline is PKR 115 but a segment finding says PKR 53.
    const baseCpa = trustedAccountBaseline(dataset, platform);

    // Worst significant segment per dimension, then take the top N by waste.
    const perDimensionWorst = [];
    for (const [dimension, records] of Object.entries(byDimension)) {
      if (!Array.isArray(records) || records.length === 0) continue;
      const analysis = analyzeDimension({
        dimension,
        records,
        baselineCpa: baseCpa,
        minSpend: SEGMENT_WASTE_MIN,
      });
      const candidate = analysis.worst;
      if (candidate && candidate.wastedSpend >= SEGMENT_WASTE_MIN) {
        perDimensionWorst.push(candidate);
      }
    }
    if (perDimensionWorst.length === 0) continue;

    perDimensionWorst.sort((a, b) => b.wastedSpend - a.wastedSpend);
    const platformSpend = summary.spend || 0;
    const currency = getReportCurrency(dataset, platform);

    for (const worst of perDimensionWorst.slice(0, SEGMENT_MAX_FINDINGS_PER_PLATFORM)) {
      const wasteShare = platformSpend > 0 ? worst.wastedSpend / platformSpend : 0;
      const severity =
        wasteShare >= 0.3 ? "CRITICAL" : wasteShare >= 0.1 ? "HIGH" : "MEDIUM";

      const wasteStr = formatMoney(worst.wastedSpend, currency);
      const spendStr = formatMoney(worst.spend, currency);
      const cpaStr = worst.cpa != null ? formatMoney(worst.cpa, currency) : "no conversions";
      const baseStr = baseCpa != null ? formatMoney(baseCpa, currency) : "n/a";
      const rootCause =
        worst.reason === "zero_conversions"
          ? `The ${worst.segment} ${worst.dimension} segment is taking real budget (${spendStr}) and real clicks but returning no conversions, while other ${worst.dimension} segments convert at the ${baseStr} baseline. Spend is being allocated to this segment without the conversion performance to justify it — typically a targeting, placement, or creative-fit mismatch for this slice.`
          : `The blended ${baseStr} baseline hides that the ${worst.segment} ${worst.dimension} segment converts at ${cpaStr} — well above it. ${wasteStr} of this segment's ${spendStr} is the excess cost of running it at a worse rate than the rest of the account, money that would do more work reallocated to segments at or below baseline.`;
      // A segment that is a LARGE share of spend AND still converts can't be
      // "excluded" — that would throw away real conversions. The honest move is
      // to REBALANCE budget toward more efficient segments. Only zero-conversion
      // or small segments are genuine "exclude it" candidates.
      const segmentSpendShare = platformSpend > 0 ? worst.spend / platformSpend : 0;
      const dominantConverting =
        worst.reason !== "zero_conversions" && worst.conversions > 0 && segmentSpendShare >= 0.4;
      const sharePct = Math.round(segmentSpendShare * 100);

      const confirmStep = dominantConverting
        ? `Shift budget away from ${worst.segment} toward your higher-converting segments — it still produces ${worst.conversions} conversions, so do NOT exclude it outright. Start with a 15–25% reallocation and re-measure.`
        : worst.dimension === "day_of_week" || worst.dimension === "weekday"
          ? "Validate the day-of-week pattern on a longer lookback before applying a permanent schedule exclusion; start with a conservative bid adjustment."
          : `Exclude or down-bid the ${worst.segment} segment after confirming the trend on the next full reporting cycle.`;

      findings.push(
        createFinding({
          ruleId: "SEG-WASTE-001",
          platform,
          severity,
          category: SEGMENT_CATEGORY[platform] || "Audience Strategy",
          title: dominantConverting
            ? `The ${worst.segment} ${worst.dimension} segment runs ${wasteStr} over baseline efficiency`
            : `The ${worst.segment} ${worst.dimension} segment is wasting ${wasteStr}`,
          detail:
            worst.reason === "zero_conversions"
              ? `The ${worst.segment} ${worst.dimension} segment spent ${spendStr} with zero conversions, against an account baseline cost per result of ${baseStr}.`
              : `The ${worst.segment} ${worst.dimension} segment has a ${cpaStr} cost per result (CPA) vs the account's ${baseStr} baseline — ${wasteStr} of its spend is the excess above what that result would cost at the baseline rate.`,
          rootCause,
          evidence: {
            dimension: worst.dimension,
            segment: worst.segment,
            currency: currency || "USD",
            spend: Math.round(worst.spend),
            spendFormatted: spendStr,
            conversions: worst.conversions,
            segmentCpa: worst.cpa,
            segmentCpaFormatted: worst.cpa != null ? cpaStr : null,
            baselineCpa: baseCpa,
            baselineCpaFormatted: baseStr,
            estimatedWaste: Math.round(worst.wastedSpend),
            estimatedWasteFormatted: wasteStr,
            wasteSharePercent: Number((wasteShare * 100).toFixed(1)),
            reason: worst.reason,
            sampleNote: worst.sampleNote,
          },
          // NOTE: the recoverable amount (wasteStr) must be the FIRST currency
          // token — the report's money parser reads the first one. Leading with
          // the CPA ("converts at PKR 112") would mis-read the finding's value as
          // the CPA in the money map + projection.
          estimatedImpact: dominantConverting
            ? `About ${wasteStr} of efficiency upside: ${worst.segment} carries ${sharePct}% of spend and converts at ${cpaStr} vs the ${baseStr} baseline. It still drives ${worst.conversions} conversions, so rebalance budget toward your more efficient segments — don't cut it.`
            : `${wasteStr} in this segment is recoverable by reducing or excluding it. Reallocate to segments performing at or below the ${baseStr} baseline CPA.`,
          fixSteps: [
            `Review the ${worst.segment} ${worst.dimension} segment in the platform UI to confirm the underperformance.`,
            confirmStep,
            "Reallocate the recovered budget to segments at or below baseline CPA.",
          ],
        })
      );
    }
  }
};

/**
 * TRACK-ANOMALY-001 — conversion-tracking integrity.
 *
 * Detects a campaign reporting conversions implausibly cheap AND voluminous
 * enough to be a misfired/mismatched conversion event (the classic Meta
 * click-to-chat / WhatsApp button-tap counted as a website lead). Runs BEFORE the
 * efficiency rules so it can stamp the platform summary with the anomaly-excluded
 * ("trusted") baseline — which then propagates to every CPA-baseline consumer via
 * accountBaselineCpa(), so genuinely healthy campaigns stop being judged against a
 * baseline the fake conversions collapsed. Fires CRITICAL under Tracking & Pixel
 * Health: a baseline you cannot trust invalidates every downstream number.
 */
const addConversionAnomalyFindings = ({ audit, dataset, findings }) => {
  for (const platform of audit.selectedPlatforms || []) {
    const campaigns = getRecordsByLevel(dataset, platform, "campaign").map((c) => ({
      name: c.name,
      spend: numberValue(c.spend),
      conversions: numberValue(c.results ?? c.conversions),
    }));
    const result = detectConversionAnomalies(campaigns);
    if (!result) continue;

    // Stamp the trusted baseline + anomaly entity names on the platform summary so
    // accountBaselineCpa() and the dispersion finding read the quarantined values.
    const summary = getPlatformSummary(dataset, platform);
    summary.anomaly = {
      trustedBaselineCpa: result.trustedBaselineCpa,
      reportedBaselineCpa: result.reportedBaselineCpa,
      trustedSpend: result.trustedSpend,
      trustedConversions: result.trustedConversions,
      entityNames: new Set(result.anomalies.map((a) => a.normName)),
      anomalies: result.anomalies,
    };
    if (dataset.summary?.platforms) dataset.summary.platforms[platform] = summary;

    const currency = getReportCurrency(dataset, platform);
    const fmt = (v) => formatMoney(v, currency);
    const worst = result.anomalies
      .slice()
      .sort((a, b) => b.conversions - a.conversions)[0];
    const totalAnomalyConv = result.anomalies.reduce((a, e) => a + e.conversions, 0);
    const names = result.anomalies.map((a) => `"${a.name}"`).join(", ");

    findings.push(
      createFinding({
        ruleId: "TRACK-ANOMALY-001",
        platform,
        severity: "CRITICAL",
        category:
          platform === "GOOGLE"
            ? "Conversion Tracking Setup"
            : platform === "TIKTOK"
              ? "Pixel & Tracking Health"
              : "Tracking & Pixel Health",
        title: `${worst.name} reports conversions too cheap to be genuine — likely a misconfigured conversion event`,
        detail: `${names} ${result.anomalies.length > 1 ? "report" : "reports"} ${totalAnomalyConv.toLocaleString()} conversions at ${fmt(worst.cpa)} — ${worst.peerMultiple}× cheaper than the ${fmt(result.peerMedianCpa)} median campaign. A conversion that cheap, at this volume, is almost never a genuine lead or purchase: it is the fingerprint of a click-to-chat / button-tap or wrong pixel event being counted as a conversion. Until it is verified, this campaign's results cannot be trusted — and because they are blended into the account, they have collapsed the apparent baseline cost from a true ${fmt(result.trustedBaselineCpa)} to a misleading ${fmt(result.reportedBaselineCpa)}.`,
        rootCause: `The reported account baseline of ${fmt(result.reportedBaselineCpa)} is an artifact of these fake-cheap conversions. The genuine campaigns run at a ${fmt(result.trustedBaselineCpa)} baseline — ${result.distortion}× higher. Every "this campaign is over baseline" judgement made against the blended number is therefore overstated, and the anomalous campaign would otherwise look like the account's best performer and be recommended for scaling.`,
        evidence: {
          dimension: "campaign",
          anomalies: result.anomalies,
          reportedBaselineCpa: result.reportedBaselineCpa,
          trustedBaselineCpa: result.trustedBaselineCpa,
          trustedSpend: result.trustedSpend,
          trustedConversions: result.trustedConversions,
          distortion: result.distortion,
          // A tracking-integrity flag, not recoverable waste — keep it out of the
          // recoverable pool (it asserts no reallocatable dollar).
          diagnostic: true,
          confidence: "high",
          minSamplePassed: true,
        },
        estimatedImpact: `Verify the conversion event before trusting any performance read on ${worst.name}. The account's true baseline cost per result is ${fmt(result.trustedBaselineCpa)}, not the ${fmt(result.reportedBaselineCpa)} the blended report shows.`,
        fixSteps: [
          `Open ${worst.name} in the platform's Events/conversion settings and confirm exactly which event is firing as the conversion.`,
          "If it is a button tap (WhatsApp / click-to-chat) or a page view rather than a genuine lead or purchase, fix the event mapping or stop counting it as a conversion.",
          "Cross-check against your CRM or inbox: how many of these conversions became real conversations or sales?",
          `Re-baseline the account to ${fmt(result.trustedBaselineCpa)} for all reporting and scaling decisions until the event is corrected.`,
        ],
      })
    );
  }
};

// Frequency saturation thresholds (pure ratios — currency-agnostic). Meta's
// audiences fatigue past ~2.5×; we leave margin before flagging.
const FREQ_ELEVATED = 2.8; // above this on material spend = saturating
const FREQ_HIGH = 3.5; // clear over-saturation → HIGH severity
const FREQ_CPM_PREMIUM = 1.3; // saturated CPM ≥ this × a fresher peer = causal evidence
const FREQ_MIN_SPEND = 1000; // material spend before saturation is worth flagging

/**
 * META-FREQ-001 — per-campaign frequency saturation, tied to CPM inflation.
 *
 * The existing rules only fire at extreme frequency (>5 account-wide, >7 ad-set);
 * they miss the costly middle ground a strategist flags: a campaign at ~3.5×
 * frequency paying a steep CPM premium over a fresher, lower-frequency peer. That
 * premium IS the saturation cost — Meta pays more per impression to keep reaching
 * an exhausted audience, so cost per result climbs the longer the campaign runs
 * against the same pool. Surfaces the single worst-saturated campaign with the
 * causal CPM comparison when a fresher peer exists. Emits no hard recoverable
 * dollar (the gain is directional efficiency, not cut-able waste).
 */
const addMetaFrequencyFindings = ({ audit, dataset, findings }) => {
  if (!audit.selectedPlatforms.includes("META")) return;
  const currency = getReportCurrency(dataset, "META");
  const fmt = (v) => formatMoney(v, currency);

  const campaigns = getRecordsByLevel(dataset, "META", "campaign")
    .map((c) => {
      const spend = numberValue(c.spend);
      const impressions = numberValue(c.impressions);
      const reach = numberValue(c.reach);
      const freq =
        numberValue(c.frequency) > 0
          ? numberValue(c.frequency)
          : reach > 0 && impressions > 0
            ? impressions / reach
            : null;
      const cpm =
        numberValue(c.cpm) > 0
          ? numberValue(c.cpm)
          : impressions > 0
            ? (spend / impressions) * 1000
            : null;
      return { name: c.name || "(unnamed campaign)", spend, impressions, freq, cpm };
    })
    .filter((c) => c.spend >= FREQ_MIN_SPEND && c.freq != null);

  // Need at least two campaigns so the CPM premium has a peer to measure against.
  if (campaigns.length < 2) return;

  const saturated = campaigns
    .filter((c) => c.freq >= FREQ_ELEVATED)
    .sort((a, b) => b.freq - a.freq || b.spend - a.spend);
  if (!saturated.length) return;
  const worst = saturated[0];

  // Causal evidence: a fresher (lower-frequency) peer paying a materially lower
  // CPM shows the premium is saturation, not just an expensive audience.
  let cpmClause = "";
  let premium = null;
  let peer = null;
  const fresher = campaigns.filter(
    (c) => c.name !== worst.name && c.freq < worst.freq && c.cpm != null && c.cpm > 0
  );
  if (worst.cpm != null && fresher.length) {
    peer = fresher.reduce((a, b) => (b.cpm < a.cpm ? b : a));
    premium = worst.cpm / peer.cpm;
    if (premium >= FREQ_CPM_PREMIUM) {
      cpmClause = ` Its ${fmt(worst.cpm)} CPM is ${Math.round((premium - 1) * 100)}% higher than ${peer.name} (${fmt(peer.cpm)} CPM at a lower ${peer.freq.toFixed(2)}× frequency) — the auction is charging a premium to keep reaching an exhausted audience.`;
    } else {
      premium = null;
      peer = null;
    }
  }

  const severity = worst.freq >= FREQ_HIGH ? "HIGH" : "MEDIUM";
  findings.push(
    createFinding({
      ruleId: "META-FREQ-001",
      platform: "META",
      severity,
      category: "Audience Strategy",
      title: `${worst.name} is saturating its audience at ${worst.freq.toFixed(2)}× frequency`,
      detail: `${worst.name} runs at ${worst.freq.toFixed(2)}× frequency on ${fmt(worst.spend)} of spend — past the ~2.5× point where audiences fatigue. The average person in the audience has already seen these ads ${worst.freq.toFixed(1)} times.${cpmClause}`,
      rootCause: premium
        ? "The audience pool is saturated: with most of the target already reached, Meta pays more per impression to find the remaining unseen users, so CPM — and therefore cost per result — climbs the longer the campaign runs against the same audience without a fresh pool."
        : "At this frequency the campaign is repeatedly serving the same people; incremental reach gets more expensive and conversion rates typically decline as fatigue sets in.",
      evidence: {
        dimension: "campaign",
        segment: worst.name,
        frequency: Number(worst.freq.toFixed(2)),
        cpm: worst.cpm != null ? Math.round(worst.cpm) : null,
        cpmPremium: premium != null ? Number(premium.toFixed(2)) : null,
        peerCampaign: peer ? peer.name : null,
        peerFrequency: peer ? Number(peer.freq.toFixed(2)) : null,
        peerCpm: peer && peer.cpm != null ? Math.round(peer.cpm) : null,
        confidence: worst.impressions >= 5000 ? "high" : "medium",
        minSamplePassed: worst.impressions >= 1000,
      },
      // No leading currency figure — this is directional efficiency upside, not
      // cut-able recoverable waste, and must not be parsed into the money map.
      estimatedImpact:
        "Capping frequency and refreshing the audience should bring CPM back toward what the lower-frequency campaigns pay, lowering cost per result without cutting spend.",
      fixSteps: [
        "Apply an ad-set frequency cap (target ≤ 2.5× over the reporting window) on this campaign.",
        "Add a fresh audience or lookalike layer to expand the pool and dilute frequency.",
        "Exclude recent converters and prior lead-form submitters so spend stops re-serving people who already acted.",
        peer
          ? `Compare its targeting against ${peer.name}, which holds a lower frequency and CPM, and migrate budget there if saturation persists.`
          : "If frequency stays high after expanding the audience, shift budget toward fresher campaigns.",
      ],
    })
  );
};

// An entity converting this many times cheaper than the median is a tracking
// artifact (the WhatsApp-tap fingerprint), not a real efficiency signal — keep it
// out of the baseline so it can't drag healthy peers into "outlier" territory.
const ANOMALY_CHEAP_MULTIPLE = 5;
const DISPERSION_MIN_SPEND = 100; // floor before an entity counts as an outlier
const DISPERSION_MATERIAL = 1000; // spend that surfaces an outlier on a thin sample

/**
 * Generic per-entity CPA dispersion. An account/blended CPA hides which entities
 * (campaigns, ad sets, ad groups) are healthy and which are catastrophic — and a
 * flat-average framing invites the wrong fix (an across-the-board cut that
 * starves the healthy entity). Ranks every entity at `level` against the account
 * baseline CPA and, when the spread is material, returns a finding naming the
 * worst rate-offender, the best entity to protect, and the full table.
 *
 * Reused by:
 *   - CAMP-CPA-001    (level "campaign", every platform)
 *   - META-ADSET-001  (level "adset",    Meta — where targeting/audiences live)
 *   - TIKTOK-ADGROUP-001 (level "adgroup", TikTok)
 *
 * @returns a finding object, or null when there is no meaningful dispersion.
 */
const buildDispersionFinding = ({ dataset, platform, level, ruleId, category, entityNoun }) => {
  // Exclude the anomaly campaigns entirely — their cheap-fake CPA is a tracking
  // artifact (surfaced by TRACK-ANOMALY-001), not a real efficiency signal, and
  // would otherwise appear as the "best entity to protect". At ad-set/ad-group
  // level the entity name differs from the campaign, so also exclude any entity
  // whose PARENT campaign is anomalous — otherwise the WhatsApp campaign's ad sets
  // re-poison the ad-set baseline (the PKR 53-not-115 contradiction one level down).
  const excluded = anomalyEntityNames(dataset, platform);
  const isAnomalyEntity = (e) =>
    excluded.has(normName(e.name)) || excluded.has(normName(e.campaignName));
  const entities = getRecordsByLevel(dataset, platform, level)
    .filter((e) => !isAnomalyEntity(e))
    .map((e) => {
      const spend = numberValue(e.spend);
      const conversions = numberValue(e.results ?? e.conversions);
      const cpa = conversions > 0 ? spend / conversions : null;
      return {
        name: e.name || `(unnamed ${entityNoun})`,
        status: e.status || null,
        resultFamily: e.resultFamily || null,
        cohort: cohortKeyOf(e),
        spend,
        conversions,
        clicks: numberValue(e.clicks),
        cpa,
      };
    })
    .filter((e) => e.spend > 0);

  // Dispersion needs at least two spending entities to be meaningful.
  if (entities.length < 2) return null;

  // Robust anomaly guard, independent of name linkage: drop entities whose own
  // cost per result is implausibly cheap vs the median (the same fingerprint
  // TRACK-ANOMALY-001 catches). At ad-set/ad-group level the campaign-name
  // exclusion can miss the anomaly's children if the parent link is absent — but
  // an ad set converting at a fraction of the median is the artifact itself, and
  // leaving it in would collapse the baseline and brand healthy peers as outliers.
  // Needs ≥4 converting peers for a robust median, or a wide-but-genuine spread
  // (the real 8×-baseline outlier) would be mistaken for the cheap anomaly.
  const convCpas = entities.filter((e) => e.cpa != null).map((e) => e.cpa).sort((a, b) => a - b);
  const medianCpa =
    convCpas.length >= 4
      ? convCpas.length % 2
        ? convCpas[(convCpas.length - 1) / 2]
        : (convCpas[convCpas.length / 2 - 1] + convCpas[convCpas.length / 2]) / 2
      : null;
  const baselineEntities = entities.filter(
    (e) => !(medianCpa && e.cpa != null && e.cpa < medianCpa / ANOMALY_CHEAP_MULTIPLE)
  );
  if (baselineEntities.length < 2) return null;

  // Judge each entity against PEERS THAT BUY THE SAME KIND OF RESULT, not one
  // blended baseline. A messaging/Telegram campaign and a website-lead campaign
  // have structurally different costs; comparing across them is apples-to-oranges
  // and brands the cheaper-by-nature destination a false "drag". Entities whose
  // cohort has no comparable peers get no CPA verdict (multiple stays null). The
  // anomaly-cheap entities are excluded from the baseline AND from the gated set
  // so they can't be flagged or crowned "best to protect".
  const cohorts = buildCohortBaselines(baselineEntities);
  const multiCohort = [...cohorts.values()].filter((c) => c.valid).length > 1;

  const gated = baselineEntities.map((e) => {
    const cohortBase = cohortBaselineFor(e, cohorts);
    const multiple = cohortBase && e.cpa != null ? e.cpa / cohortBase : null;
    const gate = gateFinding({
      spend: e.spend,
      clicks: e.clicks,
      conversions: e.conversions,
      minSpend: DISPERSION_MIN_SPEND,
      minConversions: e.conversions > 0 ? 10 : 0,
      materialSpend: DISPERSION_MATERIAL,
    });
    // Recoverable spend is FORWARD-LOOKING: you can only recover budget on a
    // campaign that is still delivering. A paused entity's overspend already
    // happened and cannot be optimised — booking it as "recoverable" is the
    // confidently-wrong-number class (a paused 9×-baseline campaign was leading
    // our headline with a number the client could never act on). Paused outliers
    // stay in the breakdown as historical context, but contribute 0 recoverable.
    let recoverable = 0;
    if (!isPausedStatus(e.status)) {
      if (e.conversions === 0) recoverable = e.spend;
      else if (cohortBase && e.cpa > cohortBase) recoverable = e.spend * (1 - cohortBase / e.cpa);
    }
    return { ...e, paused: isPausedStatus(e.status), cohortBase, multiple, surface: gate.surface, confidence: gate.confidence, recoverable };
  });

  // Outliers: ≥1.5× their OWN cohort baseline, or material spend at zero
  // conversions. A campaign with no comparable peers (cohortBase null) is never
  // flagged on CPA — we can't honestly say it's expensive.
  const outliers = gated.filter(
    (e) =>
      e.surface &&
      ((e.multiple != null && e.multiple >= 1.5) ||
        (e.conversions === 0 && e.spend >= DISPERSION_MATERIAL))
  );
  if (outliers.length === 0) return null;

  const currency = getReportCurrency(dataset, platform);
  const fmt = (v) => formatMoney(v, currency);

  // Worst by rate (the leverage signal). Zero-conversion entities that burned
  // material spend are treated as most severe (no finite multiple). Prefer the
  // worst CURRENTLY-DELIVERING outlier for the headline — the entity a reader can
  // actually act on — and only fall back to an all-paused worst when nothing live
  // is an outlier (a purely historical blow-up, framed as diagnostic below).
  const byRate = (a, b) => (b.multiple ?? Infinity) - (a.multiple ?? Infinity);
  const activeOutliers = outliers.filter((e) => !e.paused);
  const pausedOutliers = outliers.filter((e) => e.paused);
  const worst = [...(activeOutliers.length ? activeOutliers : outliers)].sort(byRate)[0];
  // No live outlier ⇒ the finding is a historical diagnostic, not a recoverable
  // money line (keeps paused waste out of the money map / headline total).
  const diagnostic = activeOutliers.length === 0;
  // The baseline the worst entity is measured against is ITS cohort's baseline,
  // not a blended account number. Best performer to protect is the lowest-CPA
  // peer WITHIN the same cohort (comparing across conversion types is invalid).
  const worstBase = worst.cohortBase;
  const best = [...baselineEntities]
    .filter((e) => e.cpa != null && e.cohort === worst.cohort)
    .sort((a, b) => a.cpa - b.cpa)[0];
  // How to name the yardstick: when the account mixes conversion types, say it's
  // the baseline for THIS type; otherwise the plain account baseline reads fine.
  const baseLabel = multiCohort
    ? `${cohortLabel(worst.cohort)}-campaign baseline`
    : "account baseline";
  const baseStr = worstBase != null ? fmt(worstBase) : null;

  const severity =
    worst.multiple == null || worst.multiple >= 5
      ? "CRITICAL"
      : worst.multiple >= 2.5
        ? "HIGH"
        : "MEDIUM";

  const totalRecoverable = outliers.reduce((s, e) => s + e.recoverable, 0);
  const entityBreakdown = [...gated]
    .sort((a, b) => (b.cpa ?? Infinity) - (a.cpa ?? Infinity))
    .map((e) => ({
      entity: e.name,
      status: e.status,
      spend: Math.round(e.spend),
      spendFormatted: fmt(e.spend),
      conversions: e.conversions,
      cpa: e.cpa != null ? Math.round(e.cpa * 100) / 100 : null,
      cpaFormatted: e.cpa != null ? fmt(e.cpa) : "no conversions",
      // Multiple is vs the entity's OWN comparable-cohort baseline; null means it
      // had no comparable peers (a singleton destination) — not "0", "unknown".
      multipleOfBaseline: e.multiple != null ? Math.round(e.multiple * 10) / 10 : null,
      comparable: e.cohortBase != null,
      resultFamily: e.resultFamily,
    }));

  const worstDesc =
    worst.cpa != null
      ? `${worst.name} has a ${fmt(worst.cpa)} cost per result — ${worst.multiple.toFixed(1)}× the ${baseStr} ${baseLabel} (the average cost per result across comparable campaigns)`
      : `${worst.name} spent ${fmt(worst.spend)} with zero conversions`;
  const protectClause =
    best && best.name !== worst.name
      ? ` By contrast, ${best.name} runs at ${fmt(best.cpa)} — at or below the same baseline. Treating the ${multiCohort ? "type" : "account"} as uniformly inefficient (an across-the-board cut) would damage the healthy ${entityNoun} while leaving the real offender untouched.`
      : "";

  const rootCause =
    worst.cpa == null
      ? `${worst.name} is spending into the auction but producing no conversions at all. Material spend with zero results in a single ${entityNoun} almost always points to a concrete, fixable cause — a blocked or disapproved asset, a targeting/geo misconfiguration, or a broken conversion path — rather than a gradual efficiency drift.`
      : `${worst.name} converts at ${worst.multiple.toFixed(1)}× the cost of comparable ${cohortLabel(worst.cohort)} ${entityNoun}s, so each result there costs far more than it does on peers buying the same kind of result. The budget concentrated in it is the lever${multiCohort ? " — and it is judged only against like-for-like campaigns, not a blended average across different conversion types" : ""}.`;

  // Recoverable framing only when a LIVE outlier exists. When every outlier is
  // paused the spend is historical — say so plainly instead of implying money the
  // client can recover this period.
  const pausedTail = pausedOutliers.length
    ? ` (${pausedOutliers.length} paused ${entityNoun}${pausedOutliers.length === 1 ? "" : "s"} also ran far above baseline historically — keep ${pausedOutliers.length === 1 ? "it" : "them"} off, not recoverable spend.)`
    : "";
  const impactText = diagnostic
    ? worst.cpa != null
      ? `${fmt(worst.spend)} was spent in ${worst.name} at ${worst.multiple.toFixed(1)}× the ${baseStr ? `${baseStr} ` : ""}${baseLabel} before it was paused — historical waste, not currently recoverable. Keep it off and protect ${best && best.name !== worst.name ? best.name : "the efficient campaigns"}.`
      : `${worst.name} spent ${fmt(worst.spend)} at zero conversions before it was paused — historical, not currently recoverable.`
    : `${fmt(totalRecoverable)} is recoverable by bringing ${activeOutliers.length === 1 ? `this ${entityNoun}` : `these ${activeOutliers.length} ${entityNoun}s`} toward the ${baseStr ? `${baseStr} ` : ""}${baseLabel} — without touching ${entityNoun}s already at or below it.${pausedTail}`;

  return createFinding({
    ruleId,
    platform,
    severity,
    category,
    title:
      worst.cpa != null
        ? `${PLATFORM_LABELS[platform]} cost per result varies sharply by ${entityNoun} — ${worst.name} runs ${worst.multiple.toFixed(1)}× the ${baseLabel}`
        : `${PLATFORM_LABELS[platform]} has a ${entityNoun} burning ${fmt(worst.spend)} at zero conversions`,
    detail: `${worstDesc}.${protectClause}${multiCohort ? ` Each ${entityNoun} is compared only against others that buy the same kind of result (${cohortLabel(worst.cohort)}), so different conversion types aren't judged against each other.` : ""}`,
    rootCause,
    evidence: {
      level,
      entityNoun,
      baselineCpa: worstBase != null ? Math.round(worstBase * 100) / 100 : null,
      baselineCpaFormatted: baseStr || "n/a",
      baselineBasis: multiCohort ? `cohort:${worst.cohort}` : "account",
      cohort: worst.cohort,
      currency: currency || "USD",
      worstEntity: worst.name,
      worstCpa: worst.cpa != null ? Math.round(worst.cpa * 100) / 100 : null,
      worstMultipleOfBaseline: worst.multiple != null ? Math.round(worst.multiple * 10) / 10 : null,
      bestEntity: best?.name || null,
      bestCpa: best?.cpa != null ? Math.round(best.cpa * 100) / 100 : null,
      outlierCount: outliers.length,
      activeOutlierCount: activeOutliers.length,
      pausedOutlierCount: pausedOutliers.length,
      // No live outlier ⇒ purely historical: keep it out of the money map and the
      // recoverable headline total (it is shown as a diagnostic, not a dollar lever).
      diagnostic,
      worstPaused: worst.paused === true,
      entityBreakdown,
      confidence: worst.confidence,
      minSamplePassed: worst.confidence === "high",
    },
    estimatedImpact: impactText,
    fixSteps: [
      `Isolate ${worst.name} and diagnose its CPA driver — audience/targeting, landing page, or bidding — before changing account-wide settings.`,
      best && best.name !== worst.name
        ? `Protect and consider scaling ${best.name} (${fmt(best.cpa)} CPA); it is the most efficient of the comparable ${entityNoun}s.`
        : `Identify the best-performing comparable ${entityNoun} and shift budget toward it.`,
      `Manage to per-${entityNoun} CPA targets by conversion type rather than a single blended account average.`,
    ],
  });
};

/**
 * CAMP-CPA-001 — per-campaign CPA dispersion, every platform.
 */
const addCampaignDecompositionFindings = ({ audit, dataset, findings }) => {
  for (const platform of audit.selectedPlatforms) {
    const finding = buildDispersionFinding({
      dataset,
      platform,
      level: "campaign",
      ruleId: "CAMP-CPA-001",
      category: "Campaign Structure",
      entityNoun: "campaign",
    });
    if (finding) findings.push(finding);
  }
};

/**
 * META-ADSET-001 — per-ad-set CPA dispersion. On Meta, audiences and targeting
 * live at the ad-set level, so a broken audience shows up as one ad set running
 * far above the account baseline while others are healthy — the Meta analog of a
 * mis-applied audience. Often the most important Meta finding on CBO accounts
 * where every ad set sits under a single campaign.
 */
const addMetaAdSetDispersionFindings = ({ audit, dataset, findings }) => {
  if (!audit.selectedPlatforms.includes("META")) return;
  const finding = buildDispersionFinding({
    dataset,
    platform: "META",
    level: "adset",
    ruleId: "META-ADSET-001",
    category: "Audience Strategy",
    entityNoun: "ad set",
  });
  if (finding) findings.push(finding);
};

// Meta effective_status values that mean an ad is policy-blocked or at risk.
// DISAPPROVED is a hard delivery stop; WITH_ISSUES still serves but is one
// violation from disapproval (and may already be throttled).
const META_POLICY_STATUSES = {
  DISAPPROVED: { label: "disapproved", hardStop: true },
  WITH_ISSUES: { label: "flagged with issues", hardStop: false },
};

const META_POLICY_MIN_SPEND = 100; // floor before a flag is worth a finding
const META_POLICY_MAX_FINDINGS = 3; // surface the most-exposed flagged ads

/**
 * META-POLICY-001 — ad policy / compliance block.
 *
 * The single highest-leverage thing in many accounts: a DISAPPROVED ad cannot
 * serve at all, so if the account's best historical ad is disapproved, no bid,
 * budget, or audience change can outperform simply restoring it. The engine was
 * previously blind to this (it scored Creative Performance 100/100 while an ad
 * was disapproved) because effective_status was fetched but never surfaced.
 *
 * Ranks flagged ads by exposed spend, emits the most material ones, and frames
 * the concentration risk (what share of account spend/results sits behind the
 * block) so leverage ranking floats it above efficiency tweaks.
 */
const addMetaPolicyFindings = ({ audit, dataset, findings }) => {
  if (!audit.selectedPlatforms.includes("META")) return;
  const ads = getRecordsByLevel(dataset, "META", "ad");
  if (!ads.length) return;

  const summary = getPlatformSummary(dataset, "META");
  const accountSpend = summary.spend || 0;
  const accountResults = summary.conversions || 0;
  const currency = getReportCurrency(dataset, "META");
  const fmt = (v) => formatMoney(v, currency);

  const flagged = ads
    .map((a) => ({
      name: a.name || "(unnamed ad)",
      campaignName: a.campaignName || null,
      status: String(a.status || "").toUpperCase(),
      spend: numberValue(a.spend),
      results: numberValue(a.results),
      reviewFeedback: a.reviewFeedback || null,
    }))
    .filter((a) => META_POLICY_STATUSES[a.status] && (a.spend >= META_POLICY_MIN_SPEND || a.results > 0))
    .sort((a, b) => b.spend - a.spend);

  if (!flagged.length) return;

  // Concentration across ALL flagged ads — the headline risk when the block sits
  // on the account's proven assets.
  const exposedSpend = flagged.reduce((s, a) => s + a.spend, 0);
  const exposedResults = flagged.reduce((s, a) => s + a.results, 0);
  const spendShare = accountSpend > 0 ? exposedSpend / accountSpend : 0;
  const resultShare = accountResults > 0 ? exposedResults / accountResults : 0;

  flagged.slice(0, META_POLICY_MAX_FINDINGS).forEach((ad) => {
    const cfg = META_POLICY_STATUSES[ad.status];
    const adSpendShare = accountSpend > 0 ? ad.spend / accountSpend : 0;
    const adResultShare = accountResults > 0 ? ad.results / accountResults : 0;

    // A hard stop on a materially-delivering ad is the account's top issue.
    const material = adSpendShare >= 0.1 || adResultShare >= 0.1;
    const severity = cfg.hardStop ? (material ? "CRITICAL" : "HIGH") : material ? "HIGH" : "MEDIUM";

    const inCampaign = ad.campaignName ? ` in "${ad.campaignName}"` : "";
    const resultClause =
      ad.results > 0
        ? ` It drove ${Math.round(ad.results)} of the account's ${Math.round(accountResults)} results (${Math.round(adResultShare * 100)}%) before the block`
        : "";
    const reasonClause = ad.reviewFeedback ? ` Policy reason reported: ${ad.reviewFeedback}.` : "";

    const detail = cfg.hardStop
      ? `The ad "${ad.name}"${inCampaign} is DISAPPROVED — a hard delivery stop. It carries ${fmt(ad.spend)} of spend (${Math.round(adSpendShare * 100)}% of the account).${resultClause}. A disapproved ad cannot serve until it is fixed and re-reviewed, so no bid, budget, or audience change can outperform restoring it.${reasonClause}`
      : `The ad "${ad.name}"${inCampaign} is flagged WITH_ISSUES — it still serves but is one violation from disapproval and may already be throttled. It carries ${fmt(ad.spend)} of spend (${Math.round(adSpendShare * 100)}% of the account).${resultClause}.${reasonClause}`;

    const rootCause = cfg.hardStop
      ? `This is a compliance block, not a strategic pause. The account's delivery is gated by Meta's policy review on a proven asset — the limiting factor is approval status, not media buying. Until it clears review the spend behind it produces nothing.`
      : `Meta has flagged a policy concern on this ad. WITH_ISSUES ads are frequently throttled quietly before escalating to a full disapproval, so the visible spend may already be under-delivering against its potential.`;

    const concentrationStep =
      flagged.length > 1 && (spendShare >= 0.5 || resultShare >= 0.5)
        ? `Treat compliance as the account's first priority: the ${flagged.length} flagged ads together hold ${fmt(exposedSpend)} (${Math.round(spendShare * 100)}% of spend) and ${Math.round(resultShare * 100)}% of all results.`
        : null;

    findings.push(
      createFinding({
        ruleId: "META-POLICY-001",
        platform: "META",
        severity,
        category: "Creative Performance",
        title: cfg.hardStop
          ? `Meta ad "${ad.name}" is disapproved and blocking delivery`
          : `Meta ad "${ad.name}" is flagged with policy issues`,
        detail,
        rootCause,
        evidence: {
          ad: ad.name,
          campaign: ad.campaignName,
          status: ad.status,
          currency: currency || "USD",
          spend: Math.round(ad.spend),
          spendFormatted: fmt(ad.spend),
          spendSharePercent: Number((adSpendShare * 100).toFixed(1)),
          results: Math.round(ad.results),
          resultSharePercent: Number((adResultShare * 100).toFixed(1)),
          policyReason: ad.reviewFeedback,
          confidence: "high",
          // A hard stop leads its severity band — no efficiency fix can beat
          // restoring delivery (see leverageScore).
          blocksDelivery: cfg.hardStop,
        },
        estimatedImpact: cfg.hardStop
          ? `${fmt(ad.spend)} of proven delivery (${Math.round(adSpendShare * 100)}% of account spend) is blocked until this ad clears review. Restoring it is the highest-leverage action in the account.`
          : `${fmt(ad.spend)} of spend (${Math.round(adSpendShare * 100)}% of the account) is exposed to a delivery downgrade or disapproval while this flag is unresolved.`,
        fixSteps: [
          "Open Ads Manager → Account Quality and read the specific policy reason attached to this ad.",
          "Correct the creative or copy to address the cited policy, then request a review — do NOT duplicate the ad, which typically reproduces the same flag.",
          concentrationStep,
          "Re-check effective status after the review completes and resume scaling only once it is APPROVED.",
        ].filter(Boolean),
      })
    );
  });
};

const META_GEO_MIN_SPEND = 200; // material foreign-market spend floor
const META_GEO_CPM_MULTIPLE = 3; // CPM this many× the home market = auction mismatch

/**
 * META-GEO-001 — geo misconfiguration / foreign-market leak.
 *
 * The root cause the engine kept missing: a campaign delivering to the wrong
 * country. Spend lands in a market the budget can't compete in, producing a
 * runaway CPM and zero conversions — which a campaign-level view reports only as
 * "zero conversions" without the why. This correlates the country split to name
 * the actual driver (e.g. PKR 2,412 delivered to Great Britain at 16.7× the
 * Pakistan CPM), so the fix is "correct the location targeting", not "pause the
 * campaign".
 */
const addMetaGeoFindings = ({ audit, dataset, findings }) => {
  if (!audit.selectedPlatforms.includes("META")) return;
  const countryRows = dataset?.data?.platforms?.META?.byDimension?.country;
  if (!Array.isArray(countryRows) || countryRows.length < 2) return;

  const currency = getReportCurrency(dataset, "META");
  const fmt = (v) => formatMoney(v, currency);

  const countries = countryRows
    .map((r) => {
      const spend = numberValue(r.spend);
      const impressions = numberValue(r.impressions);
      return {
        country: r.segment,
        spend,
        impressions,
        conversions: numberValue(r.conversions ?? r.results),
        clicks: numberValue(r.clicks),
        cpm: impressions > 0 ? (spend / impressions) * 1000 : null,
      };
    })
    .filter((c) => c.spend > 0);
  if (countries.length < 2) return;

  // The intended market is the highest-spend country; foreign leaks are judged
  // against its CPM.
  const home = [...countries].sort((a, b) => b.spend - a.spend)[0];
  const homeCpm = home.cpm;

  const leaks = countries
    .filter((c) => c !== home && c.spend >= META_GEO_MIN_SPEND)
    .map((c) => {
      const cpmMultiple = homeCpm && c.cpm ? c.cpm / homeCpm : null;
      const zeroConv = c.conversions === 0;
      const highCpm = cpmMultiple != null && cpmMultiple >= META_GEO_CPM_MULTIPLE;
      return { ...c, cpmMultiple, zeroConv, highCpm };
    })
    .filter((c) => c.zeroConv || c.highCpm)
    .sort((a, b) => b.spend - a.spend);

  if (!leaks.length) return;

  // Surface the worst leak (the others are usually the same misconfiguration).
  for (const leak of leaks.slice(0, 1)) {
    const severity = leak.zeroConv && leak.spend >= META_GEO_MIN_SPEND ? "CRITICAL" : "HIGH";
    const cpmClause =
      leak.cpmMultiple != null
        ? ` at a ${leak.cpmMultiple.toFixed(1)}× ${home.country} CPM (${fmt(leak.cpm)} vs ${fmt(homeCpm)})`
        : "";
    const convClause = leak.zeroConv
      ? "and returned zero conversions"
      : `at ${leak.conversions} conversion(s)`;

    findings.push(
      createFinding({
        ruleId: "META-GEO-001",
        platform: "META",
        severity,
        category: "Audience Strategy",
        title: `Meta spend is leaking to ${leak.country} — likely a location-targeting error`,
        detail: `${fmt(leak.spend)} was delivered to ${leak.country}${cpmClause}, ${convClause}, while your primary market (${home.country}) runs at ${fmt(homeCpm)} CPM. A budget sized for ${home.country} cannot compete in the ${leak.country} auction, which is exactly the pattern of an accidental Locations setting rather than a creative or bidding problem.`,
        rootCause: `This is a targeting misconfiguration, not a performance problem. The campaign's Locations include ${leak.country}, so spend is being auctioned in a market it was never budgeted for — producing the inflated CPM and the zero conversions. The campaign-level "zero conversions" symptom and the elevated blended CPM both trace back to this single setting.`,
        evidence: {
          country: leak.country,
          homeCountry: home.country,
          currency: currency || "USD",
          spend: Math.round(leak.spend),
          spendFormatted: fmt(leak.spend),
          conversions: leak.conversions,
          cpm: leak.cpm != null ? Math.round(leak.cpm) : null,
          homeCpm: homeCpm != null ? Math.round(homeCpm) : null,
          cpmMultipleOfHome: leak.cpmMultiple != null ? Math.round(leak.cpmMultiple * 10) / 10 : null,
          confidence: "high",
        },
        estimatedImpact: `${fmt(leak.spend)} delivered to ${leak.country} returned ${leak.conversions} conversions — recoverable by correcting the campaign's location targeting to ${home.country}.`,
        fixSteps: [
          `Open the ad set's Locations setting and confirm it is set to ${home.country} (or the intended market) — ${leak.country} delivery is almost certainly unintended.`,
          `If ${leak.country} targeting was deliberate, raise that campaign's budget to a level that can compete in the ${leak.country} auction and set a market-appropriate cost target; the current budget cannot.`,
          "Re-check the country split after the next full reporting cycle to confirm the leak has stopped.",
        ],
      })
    );
  }
};

const META_UNCAPPED_BID = "LOWEST_COST_WITHOUT_CAP"; // Highest Volume, no cost cap
const META_BID_MIN_SPEND = 1000;
const META_LEARNING_WEEKLY_MIN = 50; // Meta's ~50 events/week to exit learning
const META_FLOW_MIN_LINKCLICKS = 50;
// A click-to-result rate is a proportion; below ~20 conversions the estimate is
// too noisy to claim one campaign "converts at a fraction" of another.
const META_FLOW_MIN_RESULTS = 20;

/**
 * META-BID-001 — uncapped automatic bidding at scale, and
 * META-LEARN-001 — budgets below Meta's learning-phase minimum.
 *
 * Both are the §7 "budget & bidding" checks of a full audit: Highest Volume with
 * no cost cap has no efficiency brake as spend grows, and ad sets that can't
 * clear ~50 results/week never exit the learning phase, so their CPA never
 * stabilises. Neither is a leak today — they are scaling risks — so both are
 * MEDIUM.
 */
const addMetaBiddingFindings = ({ audit, dataset, findings }) => {
  if (!audit.selectedPlatforms.includes("META")) return;
  const summary = getPlatformSummary(dataset, "META");
  if (!(summary.conversions > 0)) return; // a cost cap / learning only matter once results exist
  const currency = getReportCurrency(dataset, "META");
  const fmt = (v) => formatMoney(v, currency);

  const campaigns = getRecordsByLevel(dataset, "META", "campaign");
  const uncapped = campaigns.filter(
    (c) => String(c.bidStrategy || "").toUpperCase() === META_UNCAPPED_BID && numberValue(c.spend) >= META_BID_MIN_SPEND
  );
  if (uncapped.length) {
    const uncappedSpend = uncapped.reduce((s, c) => s + numberValue(c.spend), 0);
    findings.push(
      createFinding({
        ruleId: "META-BID-001",
        platform: "META",
        severity: "MEDIUM",
        category: "Bidding & Budget",
        title: `${uncapped.length} Meta campaign${uncapped.length > 1 ? "s run" : " runs"} uncapped automatic bidding`,
        detail: `${uncapped.length} campaign${uncapped.length > 1 ? "s" : ""} carrying ${fmt(uncappedSpend)} use Highest Volume (lowest-cost) bidding with no cost-per-result cap. The algorithm optimises for volume regardless of efficiency — fine at small spend, but as budgets scale there is no ceiling on cost per result.`,
        rootCause: `Highest Volume bidding has no efficiency constraint by design: it spends the full budget to maximise results, not to hit a cost target. As spend grows, the absence of a cost-per-result cap is what lets CPA drift with no automatic brake.`,
        evidence: {
          uncappedCampaigns: uncapped.length,
          uncappedSpend: Math.round(uncappedSpend),
          spendFormatted: fmt(uncappedSpend),
          currency: currency || "USD",
          confidence: "high",
        },
        // No leading money figure: the uncapped spend is NOT recoverable waste —
        // it's a scaling guardrail — so it must not feed the recoverable headline.
        estimatedImpact: `These campaigns run without a cost-per-result ceiling. As budgets scale, a cost cap near your target is what keeps cost-per-result from drifting — a guardrail, not recovered spend.`,
        fixSteps: [
          "Set a cost-per-result goal (cost cap) at or slightly above your target on the highest-spend campaigns.",
          "Raise budgets only after a cap is in place, so the algorithm has an efficiency constraint and not just a volume goal.",
          "Watch for under-delivery after capping; loosen the cap slightly if delivery stalls.",
        ],
      })
    );
  }

  const weeks = Math.max(1, (audit.businessProfileSnapshot?.sectionA?.lookbackDays || 30) / 7);
  const adsets = getRecordsByLevel(dataset, "META", "adset");
  const material = adsets.filter((a) => numberValue(a.spend) >= 500);
  const underLearning = material.filter(
    (a) => numberValue(a.results ?? a.conversions) / weeks < META_LEARNING_WEEKLY_MIN
  );
  if (material.length >= 2 && underLearning.length >= Math.ceil(material.length / 2)) {
    findings.push(
      createFinding({
        ruleId: "META-LEARN-001",
        platform: "META",
        severity: "MEDIUM",
        category: "Bidding & Budget",
        title: "Ad set budgets are below Meta's learning-phase minimum",
        detail: `${underLearning.length} of ${material.length} spending ad sets are generating well under ~${META_LEARNING_WEEKLY_MIN} results per week — Meta's rough threshold to exit the learning phase. Ad sets stuck in learning deliver erratically and never let their true cost per result stabilise, so performance reads are unreliable.`,
        rootCause: `Meta's delivery system needs roughly ${META_LEARNING_WEEKLY_MIN} optimisation events per week per ad set to exit learning. At the current budgets the ad sets don't reach that volume, so they keep re-entering learning and their CPA stays noisy — the thin budget, not the creative, is the limiter.`,
        evidence: {
          adSetsUnderLearning: underLearning.length,
          spendingAdSets: material.length,
          weeklyThreshold: META_LEARNING_WEEKLY_MIN,
          confidence: "high",
        },
        estimatedImpact: "Consolidating budget into fewer ad sets (or raising daily budgets) so each clears ~50 results/week will stabilise cost per result and make performance reads trustworthy.",
        fixSteps: [
          "Consolidate overlapping ad sets so budget concentrates enough volume to exit learning.",
          "Raise daily budgets on the proven ad sets toward ~50 results/week before judging their true cost per result.",
          "Avoid frequent edits to ad sets in learning — each significant change restarts the phase.",
        ],
      })
    );
  }
};

/**
 * META-HYGIENE-001 — a dead ad set adding clutter, and
 * META-NAMING-001 — an inconsistent naming convention.
 *
 * Low-severity structural hygiene a thorough audit still calls out: a paused
 * ad set that never spent is noise that hides real structure, and generic
 * campaign names with no market/funnel signal are how a mistake (like a
 * wrong-country campaign) hides in plain sight.
 */
const addMetaHygieneFindings = ({ audit, dataset, findings }) => {
  if (!audit.selectedPlatforms.includes("META")) return;
  const adsets = getRecordsByLevel(dataset, "META", "adset");
  const campaigns = getRecordsByLevel(dataset, "META", "campaign");

  const dead = adsets.filter(
    (a) => numberValue(a.spend) === 0 && numberValue(a.impressions) === 0
  );
  if (dead.length && adsets.length > dead.length) {
    for (const a of dead.slice(0, 3)) {
      findings.push(
        createFinding({
          ruleId: "META-HYGIENE-001",
          platform: "META",
          severity: "LOW",
          category: "Campaign Structure",
          title: `Dead ad set "${a.name}" has never delivered`,
          detail: `The ad set "${a.name}"${a.campaignName ? ` in "${a.campaignName}"` : ""} has zero spend and zero impressions — it was paused before it ever ran. It adds no data and clutters the account structure.`,
          rootCause: "An ad set built and then paused (or never activated) before delivery leaves a zero-spend shell that muddies reporting and makes the live structure harder to read.",
          evidence: { adSet: a.name, campaign: a.campaignName || null, spend: 0, impressions: 0, confidence: "high" },
          estimatedImpact: "No spend impact — this is structural hygiene. Removing it makes the account easier to read and audit.",
          fixSteps: [
            `Delete or properly relaunch the empty "${a.name}" ad set.`,
            "Keep only ad sets that are live or intentionally archived to keep the structure legible.",
          ],
        })
      );
    }
  }

  // Dead campaigns: shells that exist in the account but never delivered in the
  // window (paused/archived before spend, or never activated). These come from a
  // separate structure-only bucket — the insights pull omits them — so they carry
  // zero metrics and never touched any baseline. Report them as clutter only.
  //
  // Guard: a structure-only shell can share its NAME with a campaign that actually
  // spent this window (the same campaign represented in two buckets). Excluding
  // those keeps the live campaign out of the "no delivery" list — otherwise the
  // same campaign shows up as converting in the funnel AND as dead here (a direct
  // contradiction a real Meta account exhibited).
  const spendingNames = new Set(
    campaigns.filter((c) => numberValue(c.spend) > 0).map((c) => text(c.name))
  );
  const deadCampaigns = getRecordsByLevel(dataset, "META", "campaignStructureOnly").filter(
    (c) => !spendingNames.has(text(c.name))
  );
  if (deadCampaigns.length && campaigns.length > 0) {
    const examples = deadCampaigns.slice(0, 5).map((c) => c.name);
    findings.push(
      createFinding({
        ruleId: "META-HYGIENE-002",
        platform: "META",
        severity: "LOW",
        category: "Campaign Structure",
        title: `${deadCampaigns.length} campaign${deadCampaigns.length === 1 ? "" : "s"} had no delivery in this window`,
        detail: `${deadCampaigns.length} campaign${deadCampaigns.length === 1 ? " exists" : "s exist"} in the account but spent nothing and served no impressions in the audited window (e.g. ${examples.map((n) => `"${n}"`).join(", ")}). They were paused, archived, or never activated. They add no performance data and make the live structure harder to read.`,
        rootCause: "Campaigns built and then paused (or never launched) before delivery accumulate as zero-spend shells. The insights report hides them, so they quietly pile up until the account list is cluttered with inactive entries.",
        evidence: {
          deadCampaignCount: deadCampaigns.length,
          examples,
          spend: 0,
          impressions: 0,
          confidence: "high",
        },
        estimatedImpact: "No spend impact — this is structural hygiene. Archiving or deleting them makes the account easier to read, audit, and report on.",
        fixSteps: [
          "Review the zero-delivery campaigns and delete or formally archive the ones you don't intend to relaunch.",
          "Keep only live or intentionally-paused campaigns in the active account view so the structure stays legible.",
        ],
      })
    );
  }

  // Naming convention: a structured name carries at least one delimiter that
  // encodes market/funnel/date (e.g. "Pesh | WA | 23/5"). Flag only when the
  // majority of spending campaigns are generically named.
  const spending = campaigns.filter((c) => numberValue(c.spend) > 0);
  const isStructured = (name) => /\|/.test(String(name || ""));
  const generic = spending.filter((c) => !isStructured(c.name));
  if (spending.length >= 3 && generic.length >= Math.ceil(spending.length / 2)) {
    findings.push(
      createFinding({
        ruleId: "META-NAMING-001",
        platform: "META",
        severity: "MEDIUM",
        category: "Campaign Structure",
        title: "Campaign naming is inconsistent and hides targeting at a glance",
        detail: `${generic.length} of ${spending.length} spending campaigns use generic names with no market, funnel, or date signal (e.g. "${generic[0]?.name}"). With no convention, a misconfiguration — like a campaign delivering to the wrong country — can sit unnoticed because nothing in the name flags it.`,
        rootCause: "Without an enforced naming standard, a campaign's market/objective isn't legible from its name, so structural mistakes don't stand out in the campaign list and reporting can't be sliced cleanly.",
        evidence: { genericCampaigns: generic.length, spendingCampaigns: spending.length, example: generic[0]?.name || null, confidence: "high" },
        estimatedImpact: "No direct spend impact, but a consistent convention prevents whole-campaign mistakes (wrong geo, wrong objective) from hiding and makes reporting sliceable.",
        fixSteps: [
          "Adopt a convention such as [Funnel] | [Market] | [Objective] | [Date] — e.g. WA | PK | Leads | 2026-06-18.",
          "Rename existing campaigns to match so the campaign list is self-documenting.",
        ],
      })
    );
  }
};

/**
 * META-FLOW-001 — click-to-result divergence.
 *
 * Two campaigns can buy clicks at a similar cost yet convert them very
 * differently once they land. A campaign whose results-per-link-click is a
 * fraction of the account's best is leaking at the message/landing/first-reply
 * step, not the media-buying step — a distinction a CPA-only view misses.
 */
const addMetaFunnelFindings = ({ audit, dataset, findings }) => {
  if (!audit.selectedPlatforms.includes("META")) return;
  const currency = getReportCurrency(dataset, "META");
  const fmt = (v) => formatMoney(v, currency);

  // Exclude tracking-anomaly campaigns from BOTH ends of the comparison. A
  // too-cheap-to-be-genuine campaign (WhatsApp button-tap counted as a result)
  // has a near-1:1 click-to-result rate that would otherwise become the "best"
  // benchmark — making every healthy campaign look like it converts "at a
  // fraction of your best" against fraudulent numbers. Same quarantine the
  // baselines use, so this can't fire off a contaminated yardstick.
  const excluded = anomalyEntityNames(dataset, "META");
  const isAnomaly = (c) =>
    excluded.has(normName(c.name)) || excluded.has(normName(c.campaignName));

  const campaigns = getRecordsByLevel(dataset, "META", "campaign")
    .filter((c) => !isAnomaly(c))
    .map((c) => {
      const linkClicks = numberValue(c.linkClicks);
      const results = numberValue(c.results ?? c.conversions);
      return {
        name: c.name,
        spend: numberValue(c.spend),
        resultFamily: c.resultFamily || null,
        linkClicks,
        results,
        rate: linkClicks > 0 ? results / linkClicks : null,
      };
    })
    .filter(
      (c) =>
        c.linkClicks >= META_FLOW_MIN_LINKCLICKS &&
        c.rate != null &&
        c.results >= META_FLOW_MIN_RESULTS
    );
  if (campaigns.length < 2) return;

  const best = campaigns.reduce((a, b) => (b.rate > a.rate ? b : a));
  // Only compare within the same result family. A messaging campaign converts
  // click→conversation at a far higher rate than a lead campaign converts
  // click→form-fill; flagging a lead campaign as "worse than" a messaging one is
  // a destination mismatch, not a funnel problem (the cohort-baseline principle).
  const worst = campaigns
    .filter(
      (c) =>
        c.name !== best.name &&
        c.resultFamily === best.resultFamily &&
        c.rate <= best.rate * 0.5
    )
    .sort((a, b) => b.spend - a.spend)[0];
  if (!worst) return;

  const worstPct = Math.round(worst.rate * 100);
  const bestPct = Math.round(best.rate * 100);
  findings.push(
    createFinding({
      ruleId: "META-FLOW-001",
      platform: "META",
      severity: "MEDIUM",
      category: "Creative Performance",
      title: `"${worst.name}" converts clicks at a fraction of your best campaign`,
      detail: `"${worst.name}" turns only ${worstPct}% of its link clicks into results (${worst.results} from ${worst.linkClicks}), against ${bestPct}% on "${best.name}". It is buying clicks at a comparable cost but losing them after the click — a message, landing, or first-reply problem rather than a media-buying one.`,
      rootCause: `The gap is downstream of the click: both campaigns pay to deliver traffic, but ${worst.name}'s lands on a weaker next step (offer, landing experience, or first-reply script) and converts at less than half the rate. Media buying isn't the lever here — the post-click experience is.`,
      evidence: {
        campaign: worst.name,
        clickToResultPct: worstPct,
        benchmarkCampaign: best.name,
        benchmarkClickToResultPct: bestPct,
        linkClicks: worst.linkClicks,
        results: worst.results,
        spend: Math.round(worst.spend),
        spendFormatted: fmt(worst.spend),
        currency: currency || "USD",
        confidence: "high",
      },
      estimatedImpact: `Lifting "${worst.name}" from ${worstPct}% toward the ${bestPct}% your best campaign achieves would roughly ${(best.rate / worst.rate).toFixed(1)}× its results at the same click cost.`,
      fixSteps: [
        `Review the post-click experience for "${worst.name}" — the offer, landing page, or messaging first-reply flow — against your best campaign's.`,
        "Align the ad's promise with the landing/first-reply step so clicks aren't lost at the hand-off.",
        "Re-measure click-to-result after the change rather than adjusting budget or bids first.",
      ],
    })
  );
};

// Cost-efficiency divergence: dimensions where a CPM premium / CTR lag is
// meaningful (impression-bought, display-style). Country is excluded (geo rule
// owns it); hour is excluded (day-parting is a separate pattern).
// `region`/country geography is owned by META-GEO-001; excluded here to avoid
// re-flagging the same leak on thinner data.
const META_EFF_DIMENSIONS = ["placement", "age", "device", "gender"];
const EFF_MIN_SPEND = 200; // material segment spend
const EFF_MIN_IMPRESSIONS = 1000; // a CTR/CPM read below this is noise (Wilson floor)
const EFF_DOMINANCE_SHARE = 0.9; // a segment this much of the dimension IS the account
const EFF_CPM_PREMIUM = 2.0; // CPM ≥ this × the dimension baseline = a premium
const EFF_CTR_LAG = 0.5; // CTR ≤ this fraction of the best segment = lagging
const EFF_CTR_OUTLIER_MULT = 3; // CTR > this × the median = button-tap artifact, not a benchmark
const EFF_MAX_FINDINGS = 2;

/**
 * META-EFF-001 — cost-efficiency divergence (CTR / CPM), no conversions required.
 *
 * SEG-WASTE-001 judges segments on cost-per-result, so it goes blind when a
 * breakdown carries no conversion attribution (gender) or when a segment
 * converts adequately but still over-pays for impressions. This rule covers that
 * gap using metrics that are ALWAYS available — CTR and CPM — to surface a
 * segment paying a premium for impressions and/or engaging them far less than
 * the rest of the mix (the Instagram-vs-Facebook placement gap, the 55+ age CPM
 * premium). It emits NO recoverable-dollar figure (without conversions we can't
 * claim recovered spend), so it never inflates the headline total, and it skips
 * any (dimension, segment) SEG-WASTE already flagged so the same segment is
 * never double-reported.
 */
const addMetaEfficiencyFindings = ({ audit, dataset, findings }) => {
  if (!audit.selectedPlatforms.includes("META")) return;
  // When a tracking anomaly is present, the fake clicks inflate CTR in exactly the
  // segments (the anomaly's placement, the older age brackets) that would become
  // the "best segment" benchmark — so a healthy core audience (e.g. 18-24) gets
  // branded "inefficient" against a contaminated bar, and "exclude this segment"
  // is harmful advice we can't isolate at breakdown level. Defensive by default:
  // make NO engagement-efficiency exclusion call until tracking is fixed (which is
  // also the correct professional sequence — clean the data, THEN judge segments).
  if (anomalyEntityNames(dataset, "META").size > 0) return;
  const byDimension = dataset?.data?.platforms?.META?.byDimension;
  if (!byDimension || typeof byDimension !== "object") return;
  const currency = getReportCurrency(dataset, "META");
  const fmt = (v) => formatMoney(v, currency);

  // Segments already surfaced on a CPA basis — don't re-flag them here.
  const alreadyFlagged = new Set(
    findings
      .filter((f) => f.ruleId === "SEG-WASTE-001")
      .map((f) => `${f.evidence?.dimension}:${f.evidence?.segment}`)
  );

  const candidates = [];
  for (const dim of META_EFF_DIMENSIONS) {
    const rows = byDimension[dim];
    if (!Array.isArray(rows) || rows.length < 2) continue;

    const segs = rows
      .map((r) => {
        const spend = numberValue(r.spend);
        const impressions = numberValue(r.impressions);
        const clicks = numberValue(r.clicks);
        return {
          segment: String(r.segment),
          spend,
          impressions,
          clicks,
          cpm: impressions > 0 ? (spend / impressions) * 1000 : null,
          ctr: impressions > 0 ? (clicks / impressions) * 100 : null,
        };
      })
      .filter((s) => s.impressions > 0);
    if (segs.length < 2) continue;

    const totalSpend = segs.reduce((a, s) => a + s.spend, 0);
    const totalImpr = segs.reduce((a, s) => a + s.impressions, 0);
    const baselineCpm = totalImpr > 0 ? (totalSpend / totalImpr) * 1000 : null;
    // The "best CTR" benchmark must come from a segment with a meaningful sample —
    // otherwise a 21-impression freak (28.57% CTR) makes a healthy dominant
    // segment look "inefficient". Fall back to nothing if no segment qualifies.
    const significant = segs.filter((s) => s.impressions >= EFF_MIN_IMPRESSIONS);
    // Drop implausibly-high CTR segments from the "best" benchmark. A segment
    // running several times the typical CTR is the fingerprint of button-tap /
    // click-to-chat traffic (the conversion-anomaly placement), not genuine
    // engagement — letting it set the bar brands the real audience "inefficient".
    const sigCtrs = significant.map((s) => s.ctr || 0).filter((c) => c > 0);
    const medianCtr = sigCtrs.length
      ? [...sigCtrs].sort((a, b) => a - b)[Math.floor(sigCtrs.length / 2)]
      : 0;
    const credible = significant.filter(
      (s) => medianCtr <= 0 || (s.ctr || 0) <= medianCtr * EFF_CTR_OUTLIER_MULT
    );
    const bestPool = credible.length ? credible : significant;
    const bestCtr = bestPool.length ? Math.max(...bestPool.map((s) => s.ctr || 0)) : 0;

    for (const s of segs) {
      if (s.spend < EFF_MIN_SPEND) continue;
      // The flagged segment's own CTR/CPM must be statistically meaningful.
      if (s.impressions < EFF_MIN_IMPRESSIONS) continue;
      if (alreadyFlagged.has(`${dim}:${s.segment}`)) continue;
      // Dominance: a segment that is ~all of the dimension's spend IS the account —
      // it can't be "excluded and reallocated" (the original mobile-app trap).
      const spendShare = totalSpend > 0 ? s.spend / totalSpend : 0;
      if (segs.length >= 2 && spendShare >= EFF_DOMINANCE_SHARE) continue;
      const cpmMult = baselineCpm && s.cpm ? s.cpm / baselineCpm : null;
      const ctrFrac = bestCtr > 0 && s.ctr != null ? s.ctr / bestCtr : null;
      const premium = cpmMult != null && cpmMult >= EFF_CPM_PREMIUM;
      const lagging = ctrFrac != null && ctrFrac <= EFF_CTR_LAG;
      if (!premium && !lagging) continue;
      const badness = (premium ? cpmMult : 0) + (lagging ? 1 / Math.max(ctrFrac, 0.05) : 0);
      candidates.push({
        dim,
        ...s,
        cpmMult,
        ctrFrac,
        baselineCpm,
        bestCtr,
        premium,
        lagging,
        rank: s.spend * badness,
      });
    }
  }
  if (!candidates.length) return;

  // Worst per dimension, then the top N overall by spend-weighted badness.
  const worstPerDim = new Map();
  for (const c of candidates) {
    const prev = worstPerDim.get(c.dim);
    if (!prev || c.rank > prev.rank) worstPerDim.set(c.dim, c);
  }
  const top = [...worstPerDim.values()].sort((a, b) => b.rank - a.rank).slice(0, EFF_MAX_FINDINGS);

  for (const c of top) {
    const cpmStr = c.cpm != null ? fmt(c.cpm) : "n/a";
    const baseStr = c.baselineCpm != null ? fmt(c.baselineCpm) : "n/a";
    const premiumClause = c.premium
      ? `pays a ${c.cpmMult.toFixed(1)}× CPM premium (${cpmStr} vs the ${baseStr} ${c.dim} average)`
      : null;
    const ctrClause = c.lagging
      ? `earns a ${c.ctr.toFixed(2)}% CTR — ${(c.ctrFrac * 100).toFixed(0)}% of the best ${c.dim} segment's ${c.bestCtr.toFixed(2)}%`
      : null;
    const both = premiumClause && ctrClause;
    const symptom = [premiumClause, ctrClause].filter(Boolean).join(" and ");

    findings.push(
      createFinding({
        ruleId: "META-EFF-001",
        platform: "META",
        severity: "MEDIUM",
        category: c.dim === "placement" ? "Creative Performance" : "Audience Strategy",
        title: `The ${c.segment} ${c.dim} segment buys impressions inefficiently`,
        detail: `The ${c.segment} ${c.dim} segment ${symptom}, on ${fmt(c.spend)} of spend. ${both ? "It costs more AND engages less" : c.premium ? "You are paying a premium for the same impressions" : "You are paying for impressions that don't engage"} than the rest of the ${c.dim} mix.`,
        rootCause: `This is a media-efficiency gap, not a conversion problem: ${c.segment} buys impressions at a worse rate (CPM) and/or converts them to clicks less often (CTR) than the rest of the ${c.dim} mix. Because conversions aren't the signal here, it stays invisible to a cost-per-result view — but the impression budget spent on it works harder elsewhere.`,
        evidence: {
          dimension: c.dim,
          segment: c.segment,
          currency: currency || "USD",
          spend: Math.round(c.spend),
          spendFormatted: fmt(c.spend),
          cpm: c.cpm != null ? Math.round(c.cpm) : null,
          baselineCpm: c.baselineCpm != null ? Math.round(c.baselineCpm) : null,
          cpmMultipleOfBaseline: c.cpmMult != null ? Math.round(c.cpmMult * 10) / 10 : null,
          ctrPercent: c.ctr != null ? Number(c.ctr.toFixed(2)) : null,
          bestCtrPercent: Number(c.bestCtr.toFixed(2)),
          confidence: "high",
        },
        // Deliberately no leading money figure — without conversions this is an
        // efficiency reallocation, not recovered spend, so it must not feed the
        // recoverable headline.
        estimatedImpact: `Reallocating this segment's impression budget to better-engaging ${c.dim} segments would buy more qualified clicks at the same spend.`,
        fixSteps: [
          `Exclude or down-weight the ${c.segment} ${c.dim} segment and shift that budget to the better-performing ${c.dim} segments.`,
          c.dim === "placement"
            ? "If the placement is worth keeping, test a placement-native creative variant rather than running the same asset everywhere."
            : "Confirm the pattern on the next full reporting cycle before making it a permanent exclusion.",
          "Re-check CPM and CTR by segment after the change to confirm the efficiency gain.",
        ],
      })
    );
  }
};

/**
 * TIKTOK-ADGROUP-001 — per-ad-group CPA dispersion. TikTok targeting lives at the
 * ad-group level; this surfaces the broken ad group hidden by a blended account
 * CPA.
 */
const addTikTokAdGroupDispersionFindings = ({ audit, dataset, findings }) => {
  if (!audit.selectedPlatforms.includes("TIKTOK")) return;
  const finding = buildDispersionFinding({
    dataset,
    platform: "TIKTOK",
    level: "adgroup",
    ruleId: "TIKTOK-ADGROUP-001",
    category: "Audience Strategy",
    entityNoun: "ad group",
  });
  if (finding) findings.push(finding);
};

const GOOGLE_BID_MIN_CONVERSIONS = 30; // Smart Bidding target-CPA readiness floor
const GOOGLE_BID_MIN_SPEND = 200;

/**
 * GOOGLE-BID-001 — uncapped MAXIMIZE_CONVERSIONS on a proven campaign.
 *
 * A campaign on MAXIMIZE_CONVERSIONS with no target CPA tells Google to spend the
 * whole budget regardless of efficiency. Once it has cleared ~30 conversions it
 * has the signal for a target-CPA constraint; leaving it uncapped while CPA sits
 * above target/baseline is pure overspend. Reads biddingStrategyType already
 * pulled on every campaign — no extra data.
 */
const addGoogleBiddingFindings = ({ audit, dataset, findings }) => {
  if (!audit.selectedPlatforms.includes("GOOGLE")) return;
  const campaigns = getRecordsByLevel(dataset, "GOOGLE", "campaign");
  if (campaigns.length === 0) return;

  const summary = getPlatformSummary(dataset, "GOOGLE");
  const baseCpa = baselineCpa({
    spend: summary.spend,
    conversions: summary.conversions,
  });
  const sectionA = audit.businessProfileSnapshot?.sectionA || {};
  const targetCpa = numberValue(sectionA.targetCpa);
  const intakeCurrency = sectionA.currency || "USD";
  const reference = targetCpa > 0 ? targetCpa : baseCpa; // prefer the declared target
  if (reference == null || reference <= 0) return;

  const currency = getReportCurrency(dataset, "GOOGLE");
  const fmt = (v) => formatMoney(v, currency);
  const refShort = targetCpa > 0 ? fmtIntake(targetCpa, intakeCurrency) : fmt(baseCpa);
  const refLabel =
    targetCpa > 0 ? `your ${refShort} target CPA` : `the ${refShort} account baseline CPA`;

  const candidates = campaigns
    .map((c) => {
      const spend = numberValue(c.spend);
      const conversions = numberValue(c.results ?? c.conversions);
      return {
        name: c.name || "(unnamed campaign)",
        status: c.status || null,
        strategy: c.bidStrategy || null,
        strategyKey: text(c.bidStrategy),
        spend,
        conversions,
        campaignTargetCpa: numberValue(c.targetCpa),
        cpa: conversions > 0 ? spend / conversions : null,
      };
    })
    .filter(
      (c) =>
        !isPausedStatus(c.status) &&
        c.strategyKey.includes("maximize_conversions") &&
        // A Maximize Conversions campaign WITH a target CPA is effectively capped
        // — GOOGLE-BID-002 (target vs. actual) owns it, not this "no cap" rule.
        !(c.campaignTargetCpa > 0) &&
        c.conversions >= GOOGLE_BID_MIN_CONVERSIONS &&
        c.spend >= GOOGLE_BID_MIN_SPEND &&
        c.cpa != null &&
        c.cpa > reference * 1.15 // ≥15% over reference to be worth flagging
    )
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 3); // cap noise

  for (const c of candidates) {
    const overPct = Math.round((c.cpa / reference - 1) * 100);
    const recoverable = c.spend * (1 - reference / c.cpa);
    const severity = c.cpa >= reference * 1.5 ? "HIGH" : "MEDIUM";
    findings.push(
      createFinding({
        ruleId: "GOOGLE-BID-001",
        platform: "GOOGLE",
        severity,
        category: "Bidding Strategy Alignment",
        title: `${c.name} runs Maximize Conversions with no CPA cap — ${overPct}% over ${targetCpa > 0 ? "target" : "baseline"}`,
        detail: `${c.name} is on MAXIMIZE_CONVERSIONS with no target CPA, so Google spends the full budget with no efficiency constraint. It has ${c.conversions} conversions over the window — enough signal for a target-CPA bid — yet runs at ${fmt(c.cpa)} CPA, ${overPct}% above ${refLabel}. Adding a target CPA forces the algorithm into efficiency mode and typically cuts CPA 15–25%.`,
        evidence: {
          campaign: c.name,
          biddingStrategy: c.strategy,
          conversions: c.conversions,
          spend: Math.round(c.spend),
          spendFormatted: fmt(c.spend),
          actualCpa: Math.round(c.cpa * 100) / 100,
          actualCpaFormatted: fmt(c.cpa),
          referenceCpa: Math.round(reference * 100) / 100,
          referenceBasis: targetCpa > 0 ? "declared_target" : "account_baseline",
          percentOverReference: overPct,
          minSamplePassed: true,
        },
        estimatedImpact: `About ${fmt(recoverable)} is recoverable by constraining ${c.name}'s uncapped bidding toward the ${refShort} ${targetCpa > 0 ? "target" : "baseline"} — the spend now lost to running Maximize Conversions with no ceiling.`,
        fixSteps: [
          `Switch ${c.name} from Maximize Conversions to Target CPA, starting just above the current ${fmt(c.cpa)} to avoid a delivery drop.`,
          `After 7–10 days of stable delivery, step the target down toward ${refShort}.`,
          "Keep new or low-volume campaigns on Maximize Conversions until they clear ~30 conversions, then migrate.",
        ],
      })
    );
  }
};

// ── GOOGLE-BID-002 — Smart-bidding target vs. actual ─────────────────────────

/**
 * GOOGLE-BID-002 — a campaign on Target CPA / tROAS (or Maximize Conversions
 * with a target) whose ACTUAL result misses its OWN set target by a wide margin.
 * Distinct from GOOGLE-BID-001 (no cap at all): here a target exists but isn't
 * holding — usually set below what's reachable (so Google under-delivers) or a
 * tracking lag is inflating the measured cost. Advisory (investigate the target),
 * so no recoverable-dollar figure. Fires the single worst campaign.
 */
const addGoogleBidTargetFindings = ({ audit, dataset, findings }) => {
  if (!audit.selectedPlatforms.includes("GOOGLE")) return;
  const campaigns = getRecordsByLevel(dataset, "GOOGLE", "campaign");
  if (campaigns.length === 0) return;

  const currency = getReportCurrency(dataset, "GOOGLE");
  const fmt = (v) => formatMoney(v, currency);

  const candidates = [];
  for (const c of campaigns) {
    if (isPausedStatus(c.status)) continue;
    const spend = numberValue(c.spend);
    const conversions = numberValue(c.results ?? c.conversions);
    const targetCpa = numberValue(c.targetCpa);
    const targetRoas = numberValue(c.targetRoas);

    // ── tCPA: actual CPA materially above the set target.
    if (targetCpa > 0 && conversions >= GOOGLE_BID_MIN_CONVERSIONS && spend >= GOOGLE_BID_MIN_SPEND) {
      const actualCpa = spend / conversions;
      if (actualCpa >= targetCpa * 1.3) {
        candidates.push({
          kind: "tcpa",
          name: c.name || "(unnamed campaign)",
          spend,
          target: targetCpa,
          actual: actualCpa,
          ratio: actualCpa / targetCpa,
          gapWeight: (actualCpa / targetCpa) * spend,
        });
      }
    }

    // ── tROAS: actual ROAS materially below the set target.
    if (targetRoas > 0 && conversions >= GOOGLE_BID_MIN_CONVERSIONS && spend >= GOOGLE_BID_MIN_SPEND) {
      const actualRoas = numberValue(c.roas);
      if (actualRoas > 0 && actualRoas <= targetRoas * 0.7) {
        candidates.push({
          kind: "troas",
          name: c.name || "(unnamed campaign)",
          spend,
          target: targetRoas,
          actual: actualRoas,
          ratio: targetRoas / actualRoas,
          gapWeight: (targetRoas / actualRoas) * spend,
        });
      }
    }
  }
  if (candidates.length === 0) return;

  const w = candidates.sort((a, b) => b.gapWeight - a.gapWeight)[0];
  const severity = w.ratio >= 1.6 ? "HIGH" : "MEDIUM";

  if (w.kind === "tcpa") {
    const overPct = Math.round((w.ratio - 1) * 100);
    findings.push(
      createFinding({
        ruleId: "GOOGLE-BID-002",
        platform: "GOOGLE",
        severity,
        category: "Bidding Strategy Alignment",
        title: `${w.name} is missing its Target CPA — paying ${fmt(w.actual)} against a ${fmt(w.target)} target (${overPct}% over)`,
        detail: `${w.name} is on Target CPA bidding set to ${fmt(w.target)}, but actual cost-per-conversion is ${fmt(w.actual)} — ${overPct}% above the target on ${fmt(w.spend)} of spend. When a tCPA target isn't holding, it's usually one of three things: the target is set below what the auction can realistically deliver (so Google throttles volume chasing it), conversion tracking lag is understating recent conversions, or recent target changes haven't finished relearning.`,
        rootCause: `The Target CPA bid is not being met: actual CPA runs ${overPct}% over the set target, pointing at an unrealistic target, tracking lag, or an unfinished learning period rather than a delivery setting.`,
        evidence: {
          campaign: w.name,
          targetCpa: Math.round(w.target * 100) / 100,
          actualCpa: Math.round(w.actual * 100) / 100,
          percentOverTarget: overPct,
          spend: Math.round(w.spend),
          confidence: "high",
          minSamplePassed: true,
          // A bid-target guardrail ("raise/realign the target"), not measured
          // recoverable waste — keeps the target-CPA figure in the narrative from
          // being scraped into the recoverable headline.
          advisory: true,
        },
        estimatedImpact: `Closing the gap between the ${fmt(w.target)} target and the ${fmt(w.actual)} actual brings cost-per-conversion back in line with the goal you've already set for this campaign.`,
        fixSteps: [
          `Confirm the ${fmt(w.target)} target is realistic against this campaign's recent achieved CPA — raise it toward a reachable level if Google is under-delivering to chase it.`,
          "Check conversion tracking for lag or under-counting that would inflate measured CPA.",
          "If the target was changed recently, allow 1–2 weeks of relearning before judging it.",
        ],
      })
    );
  } else {
    const underPct = Math.round((1 - w.actual / w.target) * 100);
    findings.push(
      createFinding({
        ruleId: "GOOGLE-BID-002",
        platform: "GOOGLE",
        severity,
        category: "Bidding Strategy Alignment",
        title: `${w.name} is missing its Target ROAS — achieving ${w.actual.toFixed(2)}x against a ${w.target.toFixed(2)}x target`,
        detail: `${w.name} is on Target ROAS bidding set to ${w.target.toFixed(2)}x, but actual return is ${w.actual.toFixed(2)}x — ${underPct}% below target on ${fmt(w.spend)} of spend. A tROAS that isn't holding usually means the target is set above what the auction can deliver (so Google throttles volume), conversion-value tracking is incomplete, or the strategy is still relearning.`,
        rootCause: `The Target ROAS bid is not being met: actual ROAS runs ${underPct}% under the set target, pointing at an over-ambitious target, incomplete value tracking, or an unfinished learning period.`,
        evidence: {
          campaign: w.name,
          targetRoas: Math.round(w.target * 100) / 100,
          actualRoas: Math.round(w.actual * 100) / 100,
          percentUnderTarget: underPct,
          spend: Math.round(w.spend),
          confidence: "high",
          minSamplePassed: true,
          // A bid-target guardrail, not measured recoverable waste.
          advisory: true,
        },
        estimatedImpact: `Aligning the ${w.target.toFixed(2)}x target with achievable returns lets the strategy spend into profitable demand instead of throttling to chase an unreachable goal.`,
        fixSteps: [
          `Compare the ${w.target.toFixed(2)}x target to this campaign's recent achieved ROAS — lower it toward a reachable level if volume is being starved.`,
          "Verify conversion-value tracking captures full order/lead value (not a flat or partial value).",
          "If the target changed recently, allow the strategy to relearn before judging it.",
        ],
      })
    );
  }
};

const AUDIENCE_MATERIAL_SPEND = 1000; // floor before an audience verdict surfaces

/**
 * GOOGLE-AUD-001 — mis-applied / catastrophic audience segment.
 *
 * The flagship depth finding. Aggregates per-campaign audience performance by
 * the audience's criterion id (its stable cross-campaign identity) and detects:
 *   (1) DIVERGENCE — the SAME segment runs at a healthy CPA in one campaign and
 *       a catastrophic CPA in another. This is an audience trained on one
 *       market/funnel mis-applied to another — the classic cause of a campaign's
 *       CPA collapsing while its CTR stays fine. Fires CRITICAL.
 *   (2) Otherwise, a single audience burning material spend at ≥3× the account
 *       baseline (or zero conversions). Fires HIGH.
 *
 * Needs the audience_performance records from ad_group_audience_view (OAUTH).
 */
const addGoogleAudienceFindings = ({ audit, dataset, findings }) => {
  if (!audit.selectedPlatforms.includes("GOOGLE")) return;
  const records = getRecordsByLevel(dataset, "GOOGLE", "audience_performance");
  if (!records || records.length < 2) return;

  const summary = getPlatformSummary(dataset, "GOOGLE");
  const baseCpa = baselineCpa({
    spend: summary.spend,
    conversions: summary.conversions,
  });
  if (baseCpa == null || baseCpa <= 0) return;

  const currency = getReportCurrency(dataset, "GOOGLE");
  const fmt = (v) => formatMoney(v, currency);

  // Aggregate to per-(segment, campaign).
  const segments = new Map();
  for (const r of records) {
    const id = r.criterionId || r.audienceLabel;
    if (!id) continue;
    if (!segments.has(id)) {
      segments.set(id, {
        id,
        label: r.audienceLabel || id,
        type: r.audienceType || null,
        byCampaign: new Map(),
      });
    }
    const seg = segments.get(id);
    const campaign = r.campaignName || "(unknown campaign)";
    const agg = seg.byCampaign.get(campaign) || {
      campaign,
      spend: 0,
      conversions: 0,
      clicks: 0,
    };
    agg.spend += numberValue(r.spend);
    agg.conversions += numberValue(r.conversions);
    agg.clicks += numberValue(r.clicks);
    seg.byCampaign.set(campaign, agg);
  }

  const finalize = (c) => ({
    ...c,
    cpa: c.conversions > 0 ? c.spend / c.conversions : null,
  });

  // ── (1) Divergence: same segment, healthy in one campaign, broken in another.
  const divergences = [];
  for (const seg of segments.values()) {
    const camps = [...seg.byCampaign.values()].map(finalize).filter((c) => c.spend > 0);
    if (camps.length < 2) continue;

    const converting = camps.filter((c) => c.cpa != null);
    if (converting.length === 0) continue;
    const best = converting.reduce((a, b) => (a.cpa <= b.cpa ? a : b));

    // Worst = highest-CPA converting campaign, or a zero-conversion campaign that
    // burned material spend while `best` converts fine.
    let worst = converting.reduce((a, b) => (a.cpa >= b.cpa ? a : b));
    const zeroConvBad = camps
      .filter((c) => c.conversions === 0 && c.spend >= AUDIENCE_MATERIAL_SPEND)
      .sort((a, b) => b.spend - a.spend)[0];
    if (zeroConvBad) worst = { ...zeroConvBad, cpa: null };
    if (best === worst || best.campaign === worst.campaign) continue;

    const gate = gateFinding({
      spend: worst.spend,
      clicks: worst.clicks,
      conversions: worst.conversions,
      minSpend: 200,
      minClicks: 50,
      materialSpend: AUDIENCE_MATERIAL_SPEND,
    });
    if (!gate.surface) continue;

    const worstIsZero = worst.cpa == null;
    const diverges = worstIsZero
      ? true // best converts, worst burned material spend at zero conversions
      : worst.cpa >= best.cpa * 3 && worst.cpa >= baseCpa * 2;
    if (!diverges) continue;

    const recoverable = worstIsZero
      ? worst.spend
      : worst.spend * (1 - baseCpa / worst.cpa);
    divergences.push({
      seg,
      best,
      worst,
      worstIsZero,
      recoverable,
      multiple: worstIsZero ? null : worst.cpa / best.cpa,
      confidence: gate.confidence,
    });
  }

  if (divergences.length > 0) {
    const d = divergences.sort((a, b) => b.recoverable - a.recoverable)[0];
    const { seg, best, worst } = d;
    const perCampaign = [...seg.byCampaign.values()]
      .map(finalize)
      .sort((a, b) => (b.cpa ?? Infinity) - (a.cpa ?? Infinity))
      .map((c) => ({
        campaign: c.campaign,
        spend: Math.round(c.spend),
        spendFormatted: fmt(c.spend),
        conversions: c.conversions,
        cpa: c.cpa != null ? Math.round(c.cpa * 100) / 100 : null,
        cpaFormatted: c.cpa != null ? fmt(c.cpa) : "no conversions",
      }));
    const worstClause = d.worstIsZero
      ? `spent ${fmt(worst.spend)} with zero conversions in ${worst.campaign}`
      : `runs at ${fmt(worst.cpa)} CPA in ${worst.campaign} — ${d.multiple.toFixed(1)}× its ${fmt(best.cpa)} CPA in ${best.campaign}`;

    findings.push(
      createFinding({
        ruleId: "GOOGLE-AUD-001",
        platform: "GOOGLE",
        severity: "CRITICAL",
        category: "Audience & Attribution",
        title: `Audience ${seg.label} is mis-applied — strong in ${best.campaign}, broken in ${worst.campaign}`,
        detail: `The same audience segment (${seg.label}) drives ${fmt(best.cpa)} CPA in ${best.campaign} but ${worstClause}. An audience trained on one campaign's converting users does not transfer to a different market or funnel — this is the classic cause of a campaign's CPA collapsing while its click-through rate stays healthy.`,
        evidence: {
          audienceSegment: seg.label,
          criterionId: seg.id,
          audienceType: seg.type,
          currency: currency || "USD",
          bestCampaign: best.campaign,
          bestCpa: best.cpa != null ? Math.round(best.cpa * 100) / 100 : null,
          worstCampaign: worst.campaign,
          worstCpa: worst.cpa != null ? Math.round(worst.cpa * 100) / 100 : null,
          baselineCpa: Math.round(baseCpa * 100) / 100,
          multipleVsBest: d.multiple != null ? Math.round(d.multiple * 10) / 10 : null,
          perCampaign,
          confidence: d.confidence,
          minSamplePassed: d.confidence === "high",
        },
        estimatedImpact: `${fmt(d.recoverable)} of ${worst.campaign}'s spend is going to an audience that converts elsewhere but not here. Removing it from ${worst.campaign} and rebuilding a campaign-specific audience recovers that spend.`,
        fixSteps: [
          `Remove audience ${seg.label} from ${worst.campaign} — it is a ${best.campaign} audience that does not map to this campaign's users.`,
          `Build a campaign-specific audience for ${worst.campaign} from its own market signals, then relearn on Maximize Conversions before adding a CPA target.`,
          `Keep ${seg.label} running in ${best.campaign} where it performs, and isolate it from cross-campaign overlap.`,
        ],
      })
    );
    return;
  }

  // ── (2) Fallback: a single catastrophic audience (no cross-campaign reuse).
  let worstSingle = null;
  for (const seg of segments.values()) {
    const camps = [...seg.byCampaign.values()].map(finalize);
    const totalSpend = camps.reduce((s, c) => s + c.spend, 0);
    const totalConv = camps.reduce((s, c) => s + c.conversions, 0);
    if (totalSpend < AUDIENCE_MATERIAL_SPEND) continue;
    const cpa = totalConv > 0 ? totalSpend / totalConv : null;
    const multiple = cpa != null ? cpa / baseCpa : null;
    const catastrophic =
      (multiple != null && multiple >= 3) || (totalConv === 0 && totalSpend >= AUDIENCE_MATERIAL_SPEND);
    if (!catastrophic) continue;
    const recoverable = cpa != null ? totalSpend * (1 - baseCpa / cpa) : totalSpend;
    if (!worstSingle || recoverable > worstSingle.recoverable) {
      worstSingle = { seg, cpa, multiple, totalSpend, totalConv, recoverable };
    }
  }

  if (worstSingle) {
    const { seg, cpa, totalSpend, totalConv, recoverable, multiple } = worstSingle;
    findings.push(
      createFinding({
        ruleId: "GOOGLE-AUD-001",
        platform: "GOOGLE",
        severity: "HIGH",
        category: "Audience & Attribution",
        title:
          cpa != null
            ? `Audience ${seg.label} runs at ${fmt(cpa)} CPA — ${multiple.toFixed(1)}× the account baseline`
            : `Audience ${seg.label} spent ${fmt(totalSpend)} with zero conversions`,
        detail: `The ${seg.label} audience ${cpa != null ? `runs at ${fmt(cpa)} CPA against a ${fmt(baseCpa)} account baseline` : `spent ${fmt(totalSpend)} without a single conversion`}. It is one of the largest sources of inefficient spend in the account.`,
        evidence: {
          audienceSegment: seg.label,
          criterionId: seg.id,
          audienceType: seg.type,
          currency: currency || "USD",
          audienceCpa: cpa != null ? Math.round(cpa * 100) / 100 : null,
          baselineCpa: Math.round(baseCpa * 100) / 100,
          multipleOfBaseline: multiple != null ? Math.round(multiple * 10) / 10 : null,
          spend: Math.round(totalSpend),
          conversions: totalConv,
          minSamplePassed: true,
        },
        estimatedImpact: `${fmt(recoverable)} is recoverable by reducing or replacing this audience and reallocating to segments at or below the ${fmt(baseCpa)} baseline.`,
        fixSteps: [
          `Review the ${seg.label} audience and pause or down-bid it where it carries material spend.`,
          "Replace it with a tighter, intent-matched audience and relearn before applying a CPA target.",
          "Reallocate recovered budget to audiences performing at or below baseline CPA.",
        ],
      })
    );
  }
};

// Search-term-waste thresholds (query-level negative-keyword candidates). The #1
// wasted-spend cause on Google per every audit checklist: queries the account
// paid for that never convert. Ported into the LIVE engine (it previously only
// ran in a shadow rule that never reached a report) and made currency-aware.
const ST_MIN_SPEND_PER_TERM = 20; // a term must burn at least this to matter
const ST_MIN_CLICKS_PER_TERM = 10; // …on enough clicks to trust the zero-conv signal
const ST_MIN_TOTAL_SPEND = 500; // and the account must have material search-term spend
const ST_SHARE_FIRE = 0.05; // fire at ≥5% of search-term spend wasted
const ST_SHARE_HIGH = 0.1; // HIGH at ≥10%
const ST_SHARE_CRITICAL = 0.2; // CRITICAL at ≥20%
const ST_RECOVERY_FACTOR = 0.8; // realistically recoverable share of the waste

/**
 * GOOGLE-SEARCH-TERM-001 — the queries you paid for that never convert. Reads the
 * search_term grain (search_term_view, already pulled by the normalizer): a term
 * with material spend and enough clicks but ZERO conversions is a negative-keyword
 * candidate. This is consistently the single highest-ROI Google finding, yet the
 * live engine never analysed the grain. Its wasted spend is a query-level slice of
 * campaign spend, so recoverable.js pools it into the campaign inefficiency
 * (counted once via max), never stacked on the campaign figure.
 */
const addGoogleSearchTermFindings = ({ audit, dataset, findings }) => {
  if (!audit.selectedPlatforms.includes("GOOGLE")) return;
  const terms = getRecordsByLevel(dataset, "GOOGLE", "search_term");
  if (!terms || terms.length === 0) return;
  const currency = getReportCurrency(dataset, "GOOGLE");
  const fmt = (v) => formatMoney(v, currency);

  let totalSpend = 0;
  const wasted = [];
  const byCampaign = new Map();
  for (const t of terms) {
    const spend = numberValue(t.spend);
    const clicks = numberValue(t.clicks);
    const conv = numberValue(t.conversions ?? t.results);
    totalSpend += spend;
    if (spend >= ST_MIN_SPEND_PER_TERM && clicks >= ST_MIN_CLICKS_PER_TERM && conv === 0) {
      const name = t.searchTerm || t.name || t.query || "(unknown query)";
      wasted.push({ name, spend, clicks, campaign: t.campaignName || null });
      if (t.campaignName) byCampaign.set(t.campaignName, (byCampaign.get(t.campaignName) || 0) + spend);
    }
  }
  if (totalSpend < ST_MIN_TOTAL_SPEND || wasted.length === 0) return;

  const wastedSpend = wasted.reduce((s, w) => s + w.spend, 0);
  const share = wastedSpend / totalSpend;
  const severity =
    share >= ST_SHARE_CRITICAL ? "CRITICAL" : share >= ST_SHARE_HIGH ? "HIGH" : share >= ST_SHARE_FIRE ? "MEDIUM" : null;
  if (!severity) return;

  const recoverable = wastedSpend * ST_RECOVERY_FACTOR;
  const examples = [...wasted].sort((a, b) => b.spend - a.spend).slice(0, 5).map((w) => ({
    term: w.name,
    spend: Math.round(w.spend),
    clicks: w.clicks,
    campaign: w.campaign,
  }));
  // The campaign carrying the most query waste — lets the reconciler pool this
  // into that campaign's inefficiency instead of stacking a second copy.
  const worstCampaign =
    [...byCampaign.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  findings.push(
    createFinding({
      ruleId: "GOOGLE-SEARCH-TERM-001",
      platform: "GOOGLE",
      severity,
      category: "Keyword Strategy",
      title: `${fmt(wastedSpend)} of search-term spend converted nothing — ${wasted.length} negative-keyword candidate${wasted.length === 1 ? "" : "s"}`,
      detail: `${wasted.length} search term${wasted.length === 1 ? "" : "s"} consumed ${fmt(wastedSpend)} (${Math.round(share * 100)}% of search-term spend) on ${wasted.reduce((s, w) => s + w.clicks, 0)} clicks without a single conversion. These are the queries the account is paying for that never pay back — the classic negative-keyword list.`,
      rootCause: `Broad/phrase match (or no negative-keyword maintenance) is letting budget flow to queries that don't convert. Each is a concrete negative-keyword candidate, not a bidding or landing-page problem.`,
      evidence: {
        wastedSpend: Math.round(wastedSpend),
        wastedTermCount: wasted.length,
        wastedSharePercent: Number((share * 100).toFixed(1)),
        totalSearchTermSpend: Math.round(totalSpend),
        examples,
        campaign: worstCampaign,
        currency: currency || "USD",
        confidence: "high",
        minSamplePassed: true,
      },
      estimatedImpact: `About ${fmt(recoverable)} is recoverable by adding these zero-conversion queries as negative keywords, so the budget shifts to terms that convert.`,
      fixSteps: [
        "Open Google Ads → Keywords → Search terms, sort by cost, and filter to zero conversions.",
        `Add the ${wasted.length} zero-conversion term${wasted.length === 1 ? "" : "s"} above as negative keywords at the campaign or ad-group level.`,
        "Cluster recurring junk patterns into a shared negative-keyword list for reuse across campaigns.",
        "Re-audit in ~14 days to confirm the recovered budget moved to converting queries.",
      ],
    })
  );
};

// Audience-fragmentation thresholds.
const FRAG_MIN_SEGMENTS = 5; // an ad group crammed with this many audiences
const FRAG_ZERO_SHARE = 0.6; // ≥60% of them producing nothing
const FRAG_MIN_SPEND = 1000; // on material spend

/**
 * GOOGLE-FRAG-001 — audience fragmentation. Many audience segments crammed into a
 * single ad group split the budget too thin for Smart Bidding to learn which
 * audience to back, and most segments end up producing nothing. The fix is
 * isolation: a few segments per ad group, each measurable on its own. Reads
 * audience_performance (per ad-group × audience criterion). Structural — the
 * wasted spend is already counted by the audience/campaign findings, so this
 * carries no recoverable dollar of its own.
 */
const addGoogleAudienceFragmentationFindings = ({ audit, dataset, findings }) => {
  if (!audit.selectedPlatforms.includes("GOOGLE")) return;
  const rows = getRecordsByLevel(dataset, "GOOGLE", "audience_performance");
  if (!rows || rows.length === 0) return;
  const currency = getReportCurrency(dataset, "GOOGLE");
  const fmt = (v) => formatMoney(v, currency);

  // Group audience criteria by ad group.
  const byAdGroup = new Map();
  for (const r of rows) {
    const key = r.adGroupId || `${r.campaignName}|${r.adGroupName}`;
    if (!key) continue;
    const g =
      byAdGroup.get(key) ||
      { adGroup: r.adGroupName, campaign: r.campaignName, segments: 0, zeroConv: 0, spend: 0 };
    g.segments += 1;
    if (numberValue(r.conversions) === 0) g.zeroConv += 1;
    g.spend += numberValue(r.spend);
    byAdGroup.set(key, g);
  }

  // Worst offender: most segments, then most wasted-on-nothing.
  const offenders = [...byAdGroup.values()]
    .filter(
      (g) =>
        g.segments >= FRAG_MIN_SEGMENTS &&
        g.spend >= FRAG_MIN_SPEND &&
        g.zeroConv / g.segments >= FRAG_ZERO_SHARE
    )
    .sort((a, b) => b.segments - a.segments || b.zeroConv - a.zeroConv);
  if (offenders.length === 0) return;

  const w = offenders[0];
  findings.push(
    createFinding({
      ruleId: "GOOGLE-FRAG-001",
      platform: "GOOGLE",
      severity: "MEDIUM",
      category: "Audience & Attribution",
      title: `${w.segments} audience segments are crammed into one ad group — ${w.zeroConv} produce zero conversions`,
      detail: `The "${w.adGroup}" ad group${w.campaign ? ` in "${w.campaign}"` : ""} runs ${w.segments} audience segments in a single ad group on ${fmt(w.spend)} of spend, and ${w.zeroConv} of them have produced no conversions. With the budget split this many ways, no segment accrues enough signal for Smart Bidding to learn which audience to back — so spend spreads across non-performers instead of concentrating on what converts.`,
      rootCause: "Stacking many audiences in one ad group fragments the budget and the conversion signal. Google can't isolate the winning audience, the algorithm under-optimises, and the non-converting segments quietly absorb budget.",
      evidence: {
        adGroup: w.adGroup,
        campaign: w.campaign,
        segmentCount: w.segments,
        zeroConversionSegments: w.zeroConv,
        spend: Math.round(w.spend),
        confidence: "high",
      },
      estimatedImpact: "No additional recoverable spend beyond the audience/campaign findings already counted — but isolating the segments lets Google optimise and concentrates budget on the audiences that convert.",
      fixSteps: [
        "Rebuild the ad group as 2–3 ad groups, each with ONE market-specific audience segment, so performance is measurable per audience.",
        "Pause the audience segments with zero conversions once they're isolated and confirmed.",
        "Let each ad group accumulate ~30 conversions before layering a Target CPA on top.",
      ],
    })
  );
};

/**
 * GOOGLE-DEVICE-001 — in-campaign device waste. Detects a device inside a
 * specific campaign that burns clicks/spend at zero conversions, or at ≥2× the
 * campaign's blended CPA. Needs per-campaign device records (segments.device
 * FROM campaign). The account-level device dimension (byDimension.device) only
 * tells you device performance overall; this resolves it per campaign.
 */
const addGoogleDeviceFindings = ({ audit, dataset, findings }) => {
  if (!audit.selectedPlatforms.includes("GOOGLE")) return;
  const records = getRecordsByLevel(dataset, "GOOGLE", "campaign_device");
  if (!records || records.length === 0) return;
  const currency = getReportCurrency(dataset, "GOOGLE");
  const fmt = (v) => formatMoney(v, currency);

  const byCampaign = new Map();
  for (const r of records) {
    const camp = r.campaignName || "(unknown campaign)";
    const m = byCampaign.get(camp) || { campaign: camp, devices: [], spend: 0, conversions: 0 };
    m.devices.push(r);
    m.spend += numberValue(r.spend);
    m.conversions += numberValue(r.conversions);
    byCampaign.set(camp, m);
  }

  const candidates = [];
  for (const c of byCampaign.values()) {
    if (c.devices.length < 2) continue; // need a within-campaign device split
    const campCpa = c.conversions > 0 ? c.spend / c.conversions : null;
    for (const d of c.devices) {
      const spend = numberValue(d.spend);
      const conv = numberValue(d.conversions);
      const clicks = numberValue(d.clicks);
      const cpa = conv > 0 ? spend / conv : null;
      const gate = gateFinding({
        spend,
        clicks,
        conversions: conv,
        minSpend: 100,
        minClicks: 40,
        materialSpend: 500,
      });
      if (!gate.surface) continue;
      let reason = null;
      let recoverable = 0;
      if (conv === 0) {
        reason = "zero_conversions";
        recoverable = spend;
      } else if (campCpa != null && cpa != null && cpa >= campCpa * 2) {
        reason = "worse_than_campaign";
        recoverable = spend * (1 - campCpa / cpa);
      }
      if (!reason) continue;
      candidates.push({
        campaign: c.campaign,
        device: String(d.device).toLowerCase(),
        spend,
        conv,
        clicks,
        cpa,
        campCpa,
        reason,
        recoverable,
        confidence: gate.confidence,
      });
    }
  }
  if (candidates.length === 0) return;
  candidates.sort((a, b) => b.recoverable - a.recoverable);

  for (const w of candidates.slice(0, 2)) {
    const severity =
      w.reason === "zero_conversions" && w.spend >= 500 ? "HIGH" : "MEDIUM";
    findings.push(
      createFinding({
        ruleId: "GOOGLE-DEVICE-001",
        platform: "GOOGLE",
        severity,
        category: "Bidding Strategy Alignment",
        title:
          w.reason === "zero_conversions"
            ? `${w.device} on ${w.campaign} spent ${fmt(w.spend)} with zero conversions`
            : `${w.device} on ${w.campaign} runs at ${fmt(w.cpa)} CPA vs ${fmt(w.campCpa)} for the campaign`,
        detail:
          w.reason === "zero_conversions"
            ? `Within ${w.campaign}, the ${w.device} device generated ${w.clicks} clicks and ${fmt(w.spend)} in spend with zero conversions. A device bid modifier concentrates budget on the devices that actually convert.`
            : `Within ${w.campaign}, ${w.device} runs at ${fmt(w.cpa)} CPA — more than double the campaign's ${fmt(w.campCpa)} blended CPA. A negative device bid modifier rebalances spend toward better-converting devices.`,
        evidence: {
          campaign: w.campaign,
          device: w.device,
          currency: currency || "USD",
          spend: Math.round(w.spend),
          clicks: w.clicks,
          conversions: w.conv,
          deviceCpa: w.cpa != null ? Math.round(w.cpa * 100) / 100 : null,
          campaignCpa: w.campCpa != null ? Math.round(w.campCpa * 100) / 100 : null,
          reason: w.reason,
          confidence: w.confidence,
          minSamplePassed: w.confidence === "high",
        },
        estimatedImpact: `${fmt(w.recoverable)} is recoverable by applying a ${w.reason === "zero_conversions" ? "-100%" : "negative"} ${w.device} bid modifier on ${w.campaign}.`,
        fixSteps: [
          `In ${w.campaign}, set a ${w.reason === "zero_conversions" ? "-100% (exclude)" : "-30% to -50%"} bid modifier on ${w.device}.`,
          "Re-check device CPA after 7–10 days and tune the modifier toward the campaign's blended CPA.",
          "Reallocate the freed budget to the best-converting device.",
        ],
      })
    );
  }
};

/**
 * GOOGLE-LP-001 — landing-page CVR divergence. When traffic is split across
 * multiple final URLs (often two domains, e.g. ad. vs ads.example.com), the
 * lower-converting page is silently wasting spend. Compares CVR across URLs with
 * material clicks and flags consolidating onto the better page. Needs
 * landing_page_view records.
 */
const addGoogleLandingPageFindings = ({ audit, dataset, findings }) => {
  if (!audit.selectedPlatforms.includes("GOOGLE")) return;
  const records = getRecordsByLevel(dataset, "GOOGLE", "landing_page");
  if (!records || records.length < 2) return;
  const currency = getReportCurrency(dataset, "GOOGLE");
  const fmt = (v) => formatMoney(v, currency);
  const pctOf = (v) => `${(v * 100).toFixed(2)}%`;

  const pages = records
    .map((r) => {
      const clicks = numberValue(r.clicks);
      const conversions = numberValue(r.conversions);
      return {
        url: r.url,
        spend: numberValue(r.spend),
        clicks,
        conversions,
        cvr: clicks > 0 ? conversions / clicks : null,
      };
    })
    .filter((p) => p.url && p.clicks >= 100 && p.cvr != null);
  if (pages.length < 2) return;

  const best = pages.reduce((a, b) => (a.cvr >= b.cvr ? a : b));
  const worst = pages.reduce((a, b) => (a.cvr <= b.cvr ? a : b));
  if (best.url === worst.url || best.cvr <= 0) return;
  // Divergence: best CVR ≥ 1.5× worst, and the worst page carries material spend.
  if (worst.cvr > 0 && best.cvr < worst.cvr * 1.5) return;
  if (worst.spend < 100) return;

  const ratio = worst.cvr > 0 ? worst.cvr / best.cvr : 0;
  const recoverable = worst.spend * (1 - ratio);
  const gap = worst.cvr > 0 ? best.cvr / worst.cvr : Infinity;
  const severity = worst.cvr === 0 || gap >= 2 ? "HIGH" : "MEDIUM";

  const host = (u) => {
    try {
      return new URL(u).host;
    } catch {
      return u;
    }
  };
  const twoDomains = host(best.url) !== host(worst.url);

  findings.push(
    createFinding({
      ruleId: "GOOGLE-LP-001",
      platform: "GOOGLE",
      severity,
      category: "Quality Score & Relevance",
      title: twoDomains
        ? `Traffic is split across two domains — ${pctOf(worst.cvr)} vs ${pctOf(best.cvr)} conversion rate`
        : `Landing page ${worst.url} converts at ${pctOf(worst.cvr)} vs ${pctOf(best.cvr)} for your best page`,
      detail: `${worst.url} converts at ${pctOf(worst.cvr)} while ${best.url} converts at ${pctOf(best.cvr)} on comparable traffic${twoDomains ? " — these are different domains serving the same funnel" : ""}. The clicks are paid for either way; the lower-converting page wastes the difference. Consolidating onto the better page (and auditing the weaker one for speed, mobile usability, and message match) closes the gap.`,
      evidence: {
        currency: currency || "USD",
        worstUrl: worst.url,
        worstCvr: Number((worst.cvr * 100).toFixed(2)),
        worstSpend: Math.round(worst.spend),
        bestUrl: best.url,
        bestCvr: Number((best.cvr * 100).toFixed(2)),
        twoDomains,
        minSamplePassed: true,
      },
      estimatedImpact: `${fmt(recoverable)} of ${worst.url}'s spend is the conversion-rate gap vs your best page — recoverable by consolidating traffic onto it.`,
      fixSteps: [
        `Route paid traffic to ${best.url} and stop sending it to ${worst.url}.`,
        `Run ${worst.url} through Google's Mobile-Friendly Test and PageSpeed Insights — slow or non-mobile pages are the usual cause of this gap.`,
        "Match the weaker page's offer, headline, and load speed to the better page before resuming traffic to it.",
      ],
    })
  );
};

/**
 * GOOGLE-GEO-001 — spend leaking to under-performing markets. Aggregates
 * geographic_view by country and flags a country carrying material spend at zero
 * conversions or ≥2× the account baseline CPA — the classic "ads serving outside
 * the intended market" or "interested-in-location" leak. Needs geo records.
 */
const addGoogleGeoFindings = ({ audit, dataset, findings }) => {
  if (!audit.selectedPlatforms.includes("GOOGLE")) return;
  const records = getRecordsByLevel(dataset, "GOOGLE", "geo");
  if (!records || records.length === 0) return;
  const summary = getPlatformSummary(dataset, "GOOGLE");
  const baseCpa = baselineCpa({
    spend: summary.spend,
    conversions: summary.conversions,
  });
  const currency = getReportCurrency(dataset, "GOOGLE");
  const fmt = (v) => formatMoney(v, currency);

  const byCountry = new Map();
  for (const r of records) {
    const key = r.country || r.countryId || "unknown";
    const m = byCountry.get(key) || { country: key, spend: 0, conversions: 0, clicks: 0 };
    m.spend += numberValue(r.spend);
    m.conversions += numberValue(r.conversions);
    m.clicks += numberValue(r.clicks);
    byCountry.set(key, m);
  }
  const countries = [...byCountry.values()];
  const totalSpend = countries.reduce((s, c) => s + c.spend, 0);

  const candidates = [];
  for (const c of countries) {
    if (c.spend < 500) continue;
    const cpa = c.conversions > 0 ? c.spend / c.conversions : null;
    const gate = gateFinding({
      spend: c.spend,
      clicks: c.clicks,
      conversions: c.conversions,
      minSpend: 500,
      minClicks: 50,
      materialSpend: 1000,
    });
    if (!gate.surface) continue;
    let reason = null;
    let recoverable = 0;
    if (c.conversions === 0) {
      reason = "zero_conversions";
      recoverable = c.spend;
    } else if (baseCpa != null && cpa >= baseCpa * 2) {
      reason = "worse_than_baseline";
      recoverable = c.spend * (1 - baseCpa / cpa);
    }
    if (!reason) continue;
    candidates.push({
      ...c,
      cpa,
      reason,
      recoverable,
      spendShare: totalSpend > 0 ? c.spend / totalSpend : 0,
      confidence: gate.confidence,
    });
  }
  if (candidates.length === 0) return;

  const w = candidates.sort((a, b) => b.recoverable - a.recoverable)[0];
  const severity =
    w.reason === "zero_conversions" || (w.cpa != null && baseCpa != null && w.cpa >= baseCpa * 3)
      ? "HIGH"
      : "MEDIUM";
  findings.push(
    createFinding({
      ruleId: "GOOGLE-GEO-001",
      platform: "GOOGLE",
      severity,
      category: "Audience & Attribution",
      title:
        w.reason === "zero_conversions"
          ? `${fmt(w.spend)} spent in ${w.country} with zero conversions`
          : `${w.country} runs at ${fmt(w.cpa)} CPA — well above the ${fmt(baseCpa)} account baseline`,
      detail:
        w.reason === "zero_conversions"
          ? `${w.country} absorbed ${fmt(w.spend)} (${Math.round(w.spendShare * 100)}% of geo-attributed spend) and ${w.clicks} clicks without a single conversion. This is usually ads serving outside the intended market, or to users merely interested in the location rather than physically present.`
          : `${w.country} runs at ${fmt(w.cpa)} CPA versus a ${fmt(baseCpa)} account baseline, on ${fmt(w.spend)} of spend. Location targeting or a location-of-interest setting is letting budget flow to a market that does not convert efficiently.`,
      evidence: {
        country: w.country,
        currency: currency || "USD",
        spend: Math.round(w.spend),
        clicks: w.clicks,
        conversions: w.conversions,
        geoCpa: w.cpa != null ? Math.round(w.cpa * 100) / 100 : null,
        baselineCpa: baseCpa != null ? Math.round(baseCpa * 100) / 100 : null,
        spendSharePercent: Number((w.spendShare * 100).toFixed(1)),
        reason: w.reason,
        confidence: w.confidence,
        minSamplePassed: w.confidence === "high",
      },
      estimatedImpact: `${fmt(w.recoverable)} is recoverable by excluding or down-bidding ${w.country} and tightening location targeting to physical presence in your target markets.`,
      fixSteps: [
        `Review location settings: set targeting to "Presence" (people in your target locations), not "Presence or interest".`,
        `Add ${w.country} as a location exclusion if it is outside your intended market.`,
        "Re-check geo performance after a full reporting cycle and reallocate to converting markets.",
      ],
    })
  );
};

// Per-campaign geo bleed thresholds.
const GEO_BLEED_PRIMARY_MIN_SHARE = 0.7; // primary country must dominate → single-market intent
const GEO_BLEED_MIN_SPEND = 500; // floor before a bleed slice is worth surfacing
const GEO_BLEED_CPA_MULTIPLE = 2; // a bleed country at ≥2× the campaign's home CPA

/**
 * GOOGLE-GEO-002 — a single campaign bleeding into a market it doesn't intend to
 * serve. The country-level rule (GEO-001) can't see this: a campaign built for
 * Bangladesh that also delivers in Pakistan gets its PK spend lumped with the
 * legitimate PK campaigns, so the leak hides. This rule reads the campaign×country
 * grain: when one country dominates a campaign's geo spend (single-market intent)
 * yet a DIFFERENT country still absorbs material spend at zero conversions or a
 * CPA far above the campaign's home market, that off-target spend is a geo leak —
 * almost always a missing location exclusion or a "presence-or-interest" setting.
 */
const addGoogleGeoBleedFindings = ({ audit, dataset, findings }) => {
  if (!audit.selectedPlatforms.includes("GOOGLE")) return;
  const records = getRecordsByLevel(dataset, "GOOGLE", "geo");
  if (!records || records.length === 0) return;
  const currency = getReportCurrency(dataset, "GOOGLE");
  const fmt = (v) => formatMoney(v, currency);

  // campaign → per-country rollup
  const byCampaign = new Map();
  for (const r of records) {
    const name = r.campaignName;
    const country = r.country || r.countryId;
    if (!name || !country) continue;
    const g = byCampaign.get(name) || { name, countries: new Map(), spend: 0 };
    const c = g.countries.get(country) || { country, spend: 0, conversions: 0, clicks: 0 };
    c.spend += numberValue(r.spend);
    c.conversions += numberValue(r.conversions);
    c.clicks += numberValue(r.clicks);
    g.countries.set(country, c);
    g.spend += numberValue(r.spend);
    byCampaign.set(name, g);
  }

  const bleeds = [];
  for (const g of byCampaign.values()) {
    if (g.countries.size < 2 || g.spend <= 0) continue;
    const countries = [...g.countries.values()].sort((a, b) => b.spend - a.spend);
    const primary = countries[0];
    // Single-market intent: the home country must dominate this campaign's spend.
    if (primary.spend / g.spend < GEO_BLEED_PRIMARY_MIN_SHARE) continue;
    const primaryCpa = primary.conversions > 0 ? primary.spend / primary.conversions : null;
    for (const other of countries.slice(1)) {
      if (numberValue(other.spend) < GEO_BLEED_MIN_SPEND) continue;
      const gate = gateFinding({
        spend: other.spend,
        clicks: other.clicks,
        conversions: other.conversions,
        minSpend: GEO_BLEED_MIN_SPEND,
        minClicks: 50,
        materialSpend: GEO_BLEED_MIN_SPEND,
      });
      if (!gate.surface) continue;
      const otherCpa = other.conversions > 0 ? other.spend / other.conversions : null;
      let reason = null;
      let recoverable = 0;
      if (other.conversions === 0) {
        reason = "zero_conversions";
        recoverable = other.spend;
      } else if (primaryCpa != null && otherCpa != null && otherCpa >= primaryCpa * GEO_BLEED_CPA_MULTIPLE) {
        reason = "worse_than_home";
        recoverable = other.spend * (1 - primaryCpa / otherCpa);
      }
      if (!reason) continue;
      bleeds.push({
        campaign: g.name,
        home: primary.country,
        homeCpa: primaryCpa,
        leak: other.country,
        leakSpend: other.spend,
        leakClicks: other.clicks,
        leakConversions: other.conversions,
        leakCpa: otherCpa,
        reason,
        recoverable,
        confidence: gate.confidence,
      });
    }
  }
  if (bleeds.length === 0) return;

  const w = bleeds.sort((a, b) => b.recoverable - a.recoverable)[0];
  findings.push(
    createFinding({
      ruleId: "GOOGLE-GEO-002",
      platform: "GOOGLE",
      severity: w.recoverable >= 1000 ? "HIGH" : "MEDIUM",
      category: "Audience & Attribution",
      title: `"${w.campaign}" is bleeding ${fmt(w.leakSpend)} into ${w.leak} — outside its ${w.home} target`,
      detail:
        w.reason === "zero_conversions"
          ? `"${w.campaign}" is built for ${w.home} (its dominant market) but also served ${fmt(w.leakSpend)} and ${w.leakClicks} clicks in ${w.leak} with zero conversions. A campaign sized and targeted for ${w.home} cannot compete in the ${w.leak} auction — this is the signature of a missing location exclusion or a "presence-or-interest" targeting setting.`
          : `"${w.campaign}" is built for ${w.home} (CPA ${fmt(w.homeCpa)}) but is also spending ${fmt(w.leakSpend)} in ${w.leak} at ${fmt(w.leakCpa)} CPA — ${(w.leakCpa / w.homeCpa).toFixed(1)}× its home-market cost. That off-target delivery is leaking budget a ${w.home}-tuned campaign can't convert.`,
      rootCause: `The campaign has no ${w.leak} location exclusion (or is set to "presence or interest"), so a ${w.home}-built campaign — its audience, creative, and budget tuned for ${w.home} — leaks delivery into ${w.leak}, where it can't compete.`,
      evidence: {
        campaign: w.campaign,
        country: w.leak,
        homeCountry: w.home,
        currency: currency || "USD",
        spend: Math.round(w.leakSpend),
        clicks: w.leakClicks,
        conversions: w.leakConversions,
        leakCpa: w.leakCpa != null ? Math.round(w.leakCpa * 100) / 100 : null,
        homeCpa: w.homeCpa != null ? Math.round(w.homeCpa * 100) / 100 : null,
        reason: w.reason,
        confidence: w.confidence,
        minSamplePassed: w.confidence === "high",
      },
      estimatedImpact: `${fmt(w.recoverable)} is recoverable by adding ${w.leak} as a location exclusion on "${w.campaign}" (or switching it to physical-presence targeting), so its budget stays in ${w.home} where it converts.`,
      fixSteps: [
        `On "${w.campaign}", add ${w.leak} as an excluded location — or set targeting to "Presence" (people physically in ${w.home}), not "Presence or interest".`,
        `Confirm the campaign's intended market is ${w.home} only; if ${w.leak} is wanted, build it as its own campaign with market-specific audience, creative, and budget.`,
        "Re-check the country split after a full reporting cycle to confirm the leak has stopped.",
      ],
    })
  );
};

// ── GOOGLE-IS-001 — Search Impression Share (lost to budget vs. rank) ─────────

const IS_MIN_SPEND = 500; // floor before an IS verdict is worth surfacing
const IS_BUDGET_LOST_MIN = 0.1; // ≥10% of impressions lost to budget
const IS_RANK_LOST_MIN = 0.3; // ≥30% of impressions lost to Ad Rank

/**
 * GOOGLE-IS-001 — the demand a campaign is MISSING, which no segment slice can
 * see. Search Impression Share splits lost impressions into two causes:
 *   • lost to BUDGET → a converting campaign is capped by money, not relevance.
 *     This is upside (raise the budget), not waste — so it carries no
 *     recoverable dollar figure; it's quantified in incremental conversions.
 *   • lost to RANK → bids or Quality Score are too low to win the auction. A
 *     relevance/bidding problem, not a budget one.
 * Only Search/Shopping campaigns report IS (searchImpressionShare != null);
 * Display/Video/PMax are skipped. Fires at most one finding of each kind.
 */
const addGoogleImpressionShareFindings = ({ audit, dataset, findings }) => {
  if (!audit.selectedPlatforms.includes("GOOGLE")) return;
  const campaigns = getRecordsByLevel(dataset, "GOOGLE", "campaign");
  if (campaigns.length === 0) return;

  const summary = getPlatformSummary(dataset, "GOOGLE");
  const baseCpa = baselineCpa({ spend: summary.spend, conversions: summary.conversions });
  const currency = getReportCurrency(dataset, "GOOGLE");
  const fmt = (v) => formatMoney(v, currency);
  const pct = (frac) => Math.round(frac * 100);

  // Only Search-eligible, active campaigns with material spend.
  const eligible = campaigns
    .map((c) => {
      const spend = numberValue(c.spend);
      const conversions = numberValue(c.results ?? c.conversions);
      const is = c.searchImpressionShare;
      return {
        name: c.name || "(unnamed campaign)",
        status: c.status || null,
        spend,
        conversions,
        impressions: numberValue(c.impressions),
        is: typeof is === "number" ? is : null,
        budgetLost: typeof c.searchBudgetLostIS === "number" ? c.searchBudgetLostIS : null,
        rankLost: typeof c.searchRankLostIS === "number" ? c.searchRankLostIS : null,
        cpa: conversions > 0 ? spend / conversions : null,
      };
    })
    .filter((c) => !isPausedStatus(c.status) && c.is != null && c.spend >= IS_MIN_SPEND);
  if (eligible.length === 0) return;

  // ── Budget-capped upside: a converting campaign throttled by budget. Require
  // it to be at least baseline-efficient so we never tell the user to pour money
  // into a losing campaign.
  const budgetCapped = eligible
    .filter(
      (c) =>
        c.budgetLost != null &&
        c.budgetLost >= IS_BUDGET_LOST_MIN &&
        c.conversions >= 5 &&
        c.is > 0 &&
        (baseCpa == null || (c.cpa != null && c.cpa <= baseCpa * 1.25))
    )
    .sort((a, b) => b.budgetLost * b.spend - a.budgetLost * a.spend);

  if (budgetCapped.length > 0) {
    const c = budgetCapped[0];
    const extraConversions = Math.round(c.conversions * (c.budgetLost / c.is));
    const severity = c.budgetLost >= 0.2 ? "HIGH" : "MEDIUM";
    findings.push(
      createFinding({
        ruleId: "GOOGLE-IS-001",
        platform: "GOOGLE",
        severity,
        category: "Bidding Strategy Alignment",
        title: `${c.name} is budget-capped — losing ${pct(c.budgetLost)}% of impressions to budget while converting profitably`,
        detail: `${c.name} holds only ${pct(c.is)}% search impression share and forfeits ${pct(c.budgetLost)}% of available impressions purely because the budget runs out — not because of low bids or relevance. It already converts at ${c.cpa != null ? fmt(c.cpa) : "an efficient CPA"}${baseCpa != null ? ` versus a ${fmt(baseCpa)} account baseline` : ""}, so this is proven demand left on the table.`,
        rootCause: `Daily budget caps delivery before the campaign exhausts profitable demand: ${pct(c.budgetLost)}% of eligible impressions are lost to budget, not to Ad Rank.`,
        evidence: {
          campaign: c.name,
          searchImpressionShare: Number((c.is * 100).toFixed(1)),
          budgetLostSharePercent: pct(c.budgetLost),
          rankLostSharePercent: c.rankLost != null ? pct(c.rankLost) : null,
          conversions: c.conversions,
          campaignCpa: c.cpa != null ? Math.round(c.cpa * 100) / 100 : null,
          baselineCpa: baseCpa != null ? Math.round(baseCpa * 100) / 100 : null,
          estimatedAdditionalConversions: extraConversions,
          opportunity: true,
          confidence: "high",
          minSamplePassed: true,
        },
        estimatedImpact: `Raising this campaign's budget could capture roughly ${extraConversions} more conversions per period at a similar cost-per-result — that volume is currently lost to the budget cap, not to weak bids.`,
        fixSteps: [
          `Increase ${c.name}'s daily budget in steps (start ~20–30%) while watching that CPA holds.`,
          "If the campaign is on Target CPA/ROAS, confirm the target isn't also throttling delivery.",
          "Re-check budget-lost impression share after a full cycle and keep scaling while CPA stays efficient.",
        ],
      })
    );
  }

  // ── Rank-capped: bids/Quality Score too low to win auctions.
  const rankCapped = eligible
    .filter((c) => c.rankLost != null && c.rankLost >= IS_RANK_LOST_MIN)
    .sort((a, b) => b.rankLost * b.spend - a.rankLost * a.spend);

  if (rankCapped.length > 0) {
    const c = rankCapped[0];
    findings.push(
      createFinding({
        ruleId: "GOOGLE-IS-002",
        platform: "GOOGLE",
        severity: "MEDIUM",
        category: "Quality Score & Relevance",
        title: `${c.name} loses ${pct(c.rankLost)}% of impressions to Ad Rank — a bid or Quality Score gap`,
        detail: `${c.name} forfeits ${pct(c.rankLost)}% of available impressions to Ad Rank, meaning competitors outrank it on bid × Quality Score. Unlike a budget cap, more budget won't fix this — the auction is lost before budget is the constraint.`,
        rootCause: `Ad Rank is the limiter: ${pct(c.rankLost)}% of eligible impressions are lost to rank, pointing at low bids, weak Quality Score, or thin ad relevance rather than budget.`,
        evidence: {
          campaign: c.name,
          searchImpressionShare: Number((c.is * 100).toFixed(1)),
          rankLostSharePercent: pct(c.rankLost),
          budgetLostSharePercent: c.budgetLost != null ? pct(c.budgetLost) : null,
          opportunity: true,
          confidence: "high",
          minSamplePassed: true,
        },
        estimatedImpact: `Improving Quality Score (ad relevance, expected CTR, landing-page experience) or raising bids would recover a share of these lost impressions without increasing budget.`,
        fixSteps: [
          "Tighten ad groups so keywords, ad copy, and landing page share the same intent (lifts Quality Score).",
          "Review keyword-level Quality Score components and fix the weakest (ad relevance / expected CTR / landing page).",
          "Where Quality Score is already healthy, test a measured bid increase on the highest-intent keywords.",
        ],
      })
    );
  }
};

// ── GOOGLE-CONV-001 — conversion-tracking health ─────────────────────────────

const CONV_MATERIAL_SPEND = 1000; // spend that makes a tracking gap inexcusable
const WEAK_CONV_CATEGORIES = new Set(["PAGE_VIEW"]); // optimizing toward this ≈ optimizing toward nothing

/**
 * GOOGLE-CONV-001 — is the account measuring real outcomes at all? Every CPA,
 * ROAS, and Smart Bidding decision is only as good as the conversion setup. We
 * read conversion-action CONFIG (not metrics, so the query is always valid) and
 * cross-check it against the account's recorded conversions. Fires the single
 * most severe issue found. No recoverable dollar figure — this is a measurement
 * integrity finding, not recovered waste.
 */
const addGoogleConversionTrackingFindings = ({ audit, dataset, findings }) => {
  if (!audit.selectedPlatforms.includes("GOOGLE")) return;
  const actions = getRecordsByLevel(dataset, "GOOGLE", "conversion_action");
  // No config pulled (best-effort fetch may have been skipped/failed) → can't
  // assess without risking a false positive.
  if (!actions || actions.length === 0) return;

  const summary = getPlatformSummary(dataset, "GOOGLE");
  const accountSpend = numberValue(summary.spend);
  const accountConversions = numberValue(summary.conversions);
  const currency = getReportCurrency(dataset, "GOOGLE");
  const fmt = (v) => formatMoney(v, currency);

  const enabled = actions.filter((a) => !isPausedStatus(a.status) && a.status !== "REMOVED");
  const primary = enabled.filter((a) => a.primaryForGoal === true);

  const push = (finding) => findings.push(createFinding({ ...finding, platform: "GOOGLE" }));

  // (1) No active conversion tracking at all — the most severe state.
  if (enabled.length === 0) {
    push({
      ruleId: "GOOGLE-CONV-001",
      severity: "CRITICAL",
      category: "Conversion Tracking Setup",
      title: "No active conversion tracking — every optimization decision is blind",
      detail: `The account has no enabled conversion actions. Smart Bidding has nothing to optimize toward, and every CPA, ROAS, and conversion figure in this audit is unmeasured. This is the first thing to fix before any other change is worth making.`,
      rootCause: "No enabled conversion action exists, so Google has no success signal to bid toward or report against.",
      evidence: { enabledConversionActions: 0, totalConversionActions: actions.length, confidence: "high", minSamplePassed: true },
      estimatedImpact: "Until conversion tracking is live, bidding is effectively random and audit metrics cannot be trusted.",
      fixSteps: [
        "Set up conversion tracking (Google tag / GA4 import / offline conversions) for your real business outcomes.",
        "Mark the outcome that matters (purchase, qualified lead) as the primary 'Account default' goal action.",
        "Allow 1–2 weeks of data before judging campaign performance.",
      ],
    });
    return;
  }

  // (2) Tracking is configured but recorded ZERO conversions on material spend —
  // a strong signal the tag is broken or mis-fired.
  if (accountConversions === 0 && accountSpend >= CONV_MATERIAL_SPEND) {
    push({
      ruleId: "GOOGLE-CONV-001",
      severity: "CRITICAL",
      category: "Conversion Tracking Setup",
      title: `${enabled.length} conversion action(s) configured but zero conversions recorded on ${fmt(accountSpend)} spend`,
      detail: `Conversion actions exist, yet the account recorded no conversions across ${fmt(accountSpend)} of spend in the window. That pattern almost always means the tag stopped firing, was removed from the site, or never fired correctly — not that nothing converted. Smart Bidding is currently optimizing against a flat-zero signal.`,
      rootCause: "Conversion actions are configured but firing nothing, so the measured zero is a tracking failure rather than a true performance result.",
      evidence: {
        enabledConversionActions: enabled.length,
        primaryConversionActions: primary.length,
        accountSpend: Math.round(accountSpend),
        accountConversions: 0,
        confidence: "high",
        minSamplePassed: true,
      },
      estimatedImpact: "Fixing the tag restores the signal Smart Bidding needs; until then CPA/ROAS reporting is meaningless.",
      fixSteps: [
        "Use Google Tag Assistant / the conversion diagnostics report to confirm the tag fires on the real conversion page.",
        "Check the conversion action status and the most recent recorded-conversion date.",
        "Re-validate end-to-end (test conversion) before trusting any CPA-based decision.",
      ],
    });
    return;
  }

  // (3) Conversions tracked but none marked primary — Smart Bidding optimizes
  // toward nothing.
  if (primary.length === 0) {
    push({
      ruleId: "GOOGLE-CONV-001",
      severity: "HIGH",
      category: "Conversion Tracking Setup",
      title: "Conversions are tracked but none are set as primary — bidding optimizes toward nothing",
      detail: `${enabled.length} conversion action(s) are enabled, but none is marked primary ('Account default'). Maximize Conversions and Target CPA only optimize toward primary actions, so the algorithm currently has no goal to bid toward even though data is flowing in.`,
      rootCause: "No conversion action is flagged primary-for-goal, so Smart Bidding has no optimization target despite tracking being active.",
      evidence: {
        enabledConversionActions: enabled.length,
        primaryConversionActions: 0,
        confidence: "high",
        minSamplePassed: true,
      },
      estimatedImpact: "Smart Bidding can't optimize toward your real outcome until a primary conversion action is set.",
      fixSteps: [
        "Mark your most valuable outcome (purchase / qualified lead) as a primary 'Account default' goal action.",
        "Set softer signals (page views, secondary events) to secondary so they inform but don't drive bidding.",
        "Confirm campaigns using Smart Bidding are pointed at the conversion goal that contains your primary action.",
      ],
    });
    return;
  }

  // (4) Primary actions only measure weak signals (page views).
  if (primary.length > 0 && primary.every((a) => WEAK_CONV_CATEGORIES.has(String(a.category)))) {
    push({
      ruleId: "GOOGLE-CONV-001",
      severity: "MEDIUM",
      category: "Conversion Tracking Setup",
      title: "Primary conversions only measure page views — bidding optimizes toward low-value signals",
      detail: `Every primary conversion action is a page-view-type signal, so Smart Bidding optimizes toward visits rather than real outcomes like purchases or qualified leads. The account will look like it 'converts' well while business results lag.`,
      rootCause: "All primary conversion actions are page-view category, so the optimization target is a proxy signal, not a business outcome.",
      evidence: {
        primaryConversionActions: primary.length,
        primaryCategories: [...new Set(primary.map((a) => a.category).filter(Boolean))],
        confidence: "high",
        minSamplePassed: true,
      },
      estimatedImpact: "Optimizing toward page views inflates apparent conversion volume and misallocates budget away from real outcomes.",
      fixSteps: [
        "Define and track a real outcome (purchase, lead form, qualified call) and mark it primary.",
        "Demote page-view actions to secondary so they're observed but don't drive bidding.",
        "Re-baseline CPA/ROAS targets against the new primary action.",
      ],
    });
  }
};

// ── GOOGLE-ADSTRENGTH-001 — weak responsive-search-ad strength ───────────────

const ADSTRENGTH_MIN_SPEND = 500; // material spend behind a weak ad before flagging
const WEAK_AD_STRENGTH = new Set(["poor", "average"]);

/**
 * GOOGLE-ADSTRENGTH-001 — active responsive search ads rated POOR/AVERAGE on
 * material spend. Ad Strength is Google's own readout of how complete/diverse
 * the assets are; POOR/AVERAGE caps eligibility for top slots and hurts CTR. A
 * concrete, almost-every-account fix ("add headlines/descriptions"). Quality
 * improvement, so no recoverable-dollar figure.
 */
const addGoogleAdStrengthFindings = ({ audit, dataset, findings }) => {
  if (!audit.selectedPlatforms.includes("GOOGLE")) return;
  const ads = getRecordsByLevel(dataset, "GOOGLE", "ad");
  if (!ads || ads.length === 0) return;

  const currency = getReportCurrency(dataset, "GOOGLE");
  const fmt = (v) => formatMoney(v, currency);

  const weak = ads
    .map((a) => ({
      name: a.name || "(unnamed ad)",
      adGroup: a.adGroupName || null,
      campaign: a.campaignName || null,
      status: a.status || null,
      strength: text(a.adStrength),
      strengthRaw: a.adStrength || null,
      spend: numberValue(a.spend),
      impressions: numberValue(a.impressions),
    }))
    .filter(
      (a) =>
        !isPausedStatus(a.status) &&
        WEAK_AD_STRENGTH.has(a.strength) &&
        a.spend >= ADSTRENGTH_MIN_SPEND &&
        a.impressions > 0
    )
    .sort((x, y) => y.spend - x.spend);
  if (weak.length === 0) return;

  const anyPoor = weak.some((a) => a.strength === "poor");
  const totalSpend = weak.reduce((s, a) => s + a.spend, 0);
  const worst = weak[0];
  const countLabel = weak.length === 1 ? "1 active ad is" : `${weak.length} active ads are`;

  findings.push(
    createFinding({
      ruleId: "GOOGLE-ADSTRENGTH-001",
      platform: "GOOGLE",
      severity: anyPoor ? "MEDIUM" : "LOW",
      category: "Ad Copy & Extensions",
      title: `${countLabel} rated ${anyPoor ? "POOR / AVERAGE" : "AVERAGE"} Ad Strength on ${fmt(totalSpend)} of spend`,
      detail: `${countLabel} running at ${anyPoor ? "POOR or AVERAGE" : "AVERAGE"} Ad Strength behind ${fmt(totalSpend)} of spend — the worst is "${worst.name}"${worst.adGroup ? ` in ${worst.adGroup}` : ""} (${worst.strengthRaw}). Ad Strength reflects how complete and distinct the responsive-search assets are; POOR/AVERAGE limits eligibility for premium positions and typically drags CTR. Adding headlines and descriptions (and reducing pinning) is the most reliable lift.`,
      rootCause: `Responsive search ads lack asset breadth/diversity, so Google rates their strength ${anyPoor ? "POOR/AVERAGE" : "AVERAGE"} and limits how often they show in stronger positions.`,
      evidence: {
        weakAdCount: weak.length,
        anyPoor,
        spendBehindWeakAds: Math.round(totalSpend),
        worstAd: worst.name,
        worstAdGroup: worst.adGroup,
        worstStrength: worst.strengthRaw,
        confidence: "high",
        minSamplePassed: true,
      },
      estimatedImpact: `Lifting these ads to GOOD/EXCELLENT widens auction eligibility and usually improves CTR — a relevance and reach gain on spend you're already running.`,
      fixSteps: [
        `Open ${worst.adGroup ? `the "${worst.adGroup}" ad group` : "each flagged ad group"} and add headlines/descriptions until Ad Strength reaches GOOD or better (aim for 12–15 distinct headlines, 3–4 descriptions).`,
        "Unpin or minimize pinned assets so Google can test more combinations.",
        "Make headlines distinct (benefit, feature, offer, CTA) rather than near-duplicates.",
      ],
    })
  );
};

// ── GOOGLE-EXT-001 — missing ad-extension coverage ───────────────────────────

const EXT_MIN_SPEND = 1000; // spend behind a Search campaign before extensions matter
const CORE_EXTENSION_TYPES = ["SITELINK", "CALLOUT", "STRUCTURED_SNIPPET"];

/**
 * GOOGLE-EXT-001 — Search campaigns spending materially with no sitelinks, or
 * missing most core extension types. Extensions add SERP real estate and lift
 * CTR at no extra CPC; their absence is a classic, easy audit win. Stays silent
 * when no asset config was pulled (can't distinguish empty from fetch failure).
 */
// Budget-allocation thresholds.
const ALLOC_MIN_CONVERSIONS = 20; // a paused campaign needs this many to count as "proven"
const ALLOC_BETTER_RATIO = 0.6; // a paused winner at ≤60% of the live CPA is materially better

/**
 * GOOGLE-ALLOC-001 — the account is live on a weak campaign while proven winners
 * sit paused. This is the most actionable structural call there is: when the only
 * (or dominant) currently-delivering campaign converts far worse than a paused
 * campaign that already proved a strong CPA on real volume, the single fastest CPA
 * win is to re-enable the winner and cut/redirect the loser — no new creative or
 * audience work needed. Reads campaign status + CPA + conversions.
 */
const addGoogleAllocationFindings = ({ audit, dataset, findings }) => {
  if (!audit.selectedPlatforms.includes("GOOGLE")) return;
  const campaigns = getRecordsByLevel(dataset, "GOOGLE", "campaign");
  if (campaigns.length === 0) return;
  const currency = getReportCurrency(dataset, "GOOGLE");
  const fmt = (v) => formatMoney(v, currency);

  const cpaOf = (c) => {
    const conv = numberValue(c.results ?? c.conversions);
    const spend = numberValue(c.spend);
    return conv > 0 ? (c.cpa != null ? numberValue(c.cpa) : spend / conv) : null;
  };

  // Currently-delivering campaigns that actually spent.
  const active = campaigns.filter((c) => !isPausedStatus(c.status) && numberValue(c.spend) > 0);
  if (active.length === 0) return;
  // The live set's conversion-weighted CPA.
  const activeSpend = active.reduce((s, c) => s + numberValue(c.spend), 0);
  const activeConv = active.reduce((s, c) => s + numberValue(c.results ?? c.conversions), 0);
  const activeCpa = activeConv > 0 ? activeSpend / activeConv : null;
  if (activeCpa == null) return;

  // Paused campaigns that PROVED a strong CPA on real volume.
  const provenPaused = campaigns
    .filter(
      (c) =>
        isPausedStatus(c.status) &&
        numberValue(c.results ?? c.conversions) >= ALLOC_MIN_CONVERSIONS &&
        cpaOf(c) != null
    )
    .map((c) => ({ name: c.name, cpa: cpaOf(c), conv: numberValue(c.results ?? c.conversions) }))
    .sort((a, b) => a.cpa - b.cpa);
  if (provenPaused.length === 0) return;

  const winner = provenPaused[0];
  // Only fire when the paused winner is MATERIALLY better than the live set.
  if (!(winner.cpa <= activeCpa * ALLOC_BETTER_RATIO)) return;

  // Reallocation savings: the live budget is buying results at activeCpa; the
  // proven winner buys them at winner.cpa. Recovering the gap on the live spend
  // is the lever. This is the SAME live-campaign pool the dispersion finding
  // (CAMP-CPA) already measures, so it is campaign-scoped and reconciled (counted
  // once, never stacked) via recoverable.js — the carrier with the larger figure
  // wins the pool and the other nets to 0.
  const recoverable = activeSpend * (1 - winner.cpa / activeCpa);
  // The live campaign that owns this spend pool (highest-spend live campaign),
  // so the reconciler can group ALLOC with the dispersion finding on it.
  const liveRep = [...active].sort((a, b) => numberValue(b.spend) - numberValue(a.spend))[0];

  const liveLabel =
    active.length === 1
      ? `"${active[0].name}" (${fmt(active[0].cpa != null ? active[0].cpa : activeCpa)} CPA)`
      : `your ${active.length} live campaigns (${fmt(activeCpa)} blended CPA)`;
  const otherWinners = provenPaused
    .slice(1, 3)
    .filter((w) => w.cpa <= activeCpa * ALLOC_BETTER_RATIO);
  const winnerList = [winner, ...otherWinners]
    .map((w) => `"${w.name}" (${fmt(w.cpa)} CPA, ${Math.round(w.conv)} conversions)`)
    .join("; ");

  findings.push(
    createFinding({
      ruleId: "GOOGLE-ALLOC-001",
      platform: "GOOGLE",
      severity: "CRITICAL",
      category: "Bidding Strategy Alignment",
      title: `The account is live on a weaker campaign while a proven winner sits paused`,
      detail: `Right now ${liveLabel} is the spending campaign, but ${winnerList} ${otherWinners.length ? "are" : "is"} PAUSED despite a far better, already-proven cost per result. The account is delivering on its weaker performer while the campaign that converts efficiently is idle — so spend is buying expensive results it doesn't have to.`,
      rootCause: "Winners were paused and a weaker campaign left running — a campaign-management gap, not a bidding or audience problem. The efficient campaign already exists; it just isn't on.",
      evidence: {
        liveCampaign: active.length === 1 ? active[0].name : null,
        // The campaign that owns the spend pool — lets the reconciler group ALLOC
        // with the dispersion finding on the same live campaign (counted once).
        campaign: liveRep?.name || null,
        liveCpa: Math.round(activeCpa * 100) / 100,
        liveCount: active.length,
        pausedWinner: winner.name,
        pausedWinnerCpa: Math.round(winner.cpa * 100) / 100,
        pausedWinnerConversions: Math.round(winner.conv),
        reallocationRecoverable: Math.round(recoverable),
        // The reallocation is the fastest CPA win in the account — it must lead
        // its severity band even against a dispersion finding carrying a bigger
        // raw (often paused, non-recoverable) dollar figure.
        leadsSeverityBand: true,
        confidence: "high",
      },
      estimatedImpact: `About ${fmt(recoverable)} is recoverable by re-enabling ${winner.name} (${fmt(winner.cpa)} CPA) in place of the weaker live ${active.length === 1 ? `"${active[0].name}"` : "campaigns"} (${fmt(activeCpa)} CPA) — the single fastest cost-per-result win in the account, needing no new creative or audience work, just turning the proven campaign back on.`,
      fixSteps: [
        `Re-enable "${winner.name}" today — it already converts at ${fmt(winner.cpa)} on ${Math.round(winner.conv)} conversions.`,
        active.length === 1
          ? `Cut or pause the live "${active[0].name}" (${fmt(active[0].cpa != null ? active[0].cpa : activeCpa)} CPA); if keeping it for data, drop its budget sharply.`
          : `Redirect budget from the weaker live campaigns toward the re-enabled winner.`,
        "Confirm the re-enabled campaign keeps its prior targeting/bid settings so it resumes at its proven efficiency.",
      ],
    })
  );
};

/**
 * GOOGLE-HYGIENE-001 — dead campaigns clutter. Unlike Meta insights (which omit
 * zero-delivery campaigns), the Google pull keeps every campaign in byLevel, so
 * the shells that spent nothing in the window are already here. A thorough audit
 * calls out the clutter (a senior manager archives these monthly) — but it is
 * structural hygiene, never recoverable spend.
 */
const addGoogleHygieneFindings = ({ audit, dataset, findings }) => {
  if (!audit.selectedPlatforms.includes("GOOGLE")) return;
  const campaigns = getRecordsByLevel(dataset, "GOOGLE", "campaign");
  if (campaigns.length === 0) return;

  const spending = campaigns.filter((c) => numberValue(c.spend) > 0);
  const dead = campaigns.filter(
    (c) => numberValue(c.spend) === 0 && numberValue(c.impressions) === 0
  );
  // Only flag when there is a live account to contrast against and the clutter is
  // material (a couple of paused shells isn't worth a finding).
  if (spending.length === 0 || dead.length < 3) return;

  const examples = dead.slice(0, 5).map((c) => c.name).filter(Boolean);
  findings.push(
    createFinding({
      ruleId: "GOOGLE-HYGIENE-001",
      platform: "GOOGLE",
      severity: "LOW",
      category: "Campaign Structure",
      title: `${dead.length} campaigns had no delivery in this window`,
      detail: `${dead.length} of ${campaigns.length} campaigns spent nothing and served no impressions in the audited window (e.g. ${examples.map((n) => `"${n}"`).join(", ")}). They were paused, archived, or never activated. They add no performance data and make the live account harder to read, audit, and report on.`,
      rootCause: "Campaigns built and then paused or abandoned without an archiving discipline accumulate as zero-delivery shells that clutter the account and slow every later optimisation pass.",
      evidence: {
        deadCampaignCount: dead.length,
        totalCampaigns: campaigns.length,
        examples,
        spend: 0,
        impressions: 0,
        confidence: "high",
      },
      estimatedImpact: "No spend impact — this is structural hygiene. Archiving or deleting them makes the account easier to read, audit, and scale.",
      fixSteps: [
        "Review the zero-delivery campaigns and archive or delete the ones you don't intend to relaunch.",
        "Keep only live or intentionally-paused campaigns in the active view so the structure stays legible.",
        "Adopt a monthly cleanup pass so dead campaigns don't accumulate.",
      ],
    })
  );
};

const addGoogleExtensionFindings = ({ audit, dataset, findings }) => {
  if (!audit.selectedPlatforms.includes("GOOGLE")) return;
  const assets = getRecordsByLevel(dataset, "GOOGLE", "campaign_asset");
  // No asset config at all → don't risk a false positive on a skipped fetch.
  if (!assets || assets.length === 0) return;
  const campaigns = getRecordsByLevel(dataset, "GOOGLE", "campaign");
  if (campaigns.length === 0) return;

  const currency = getReportCurrency(dataset, "GOOGLE");
  const fmt = (v) => formatMoney(v, currency);

  // Present extension types per campaign (by id, falling back to name).
  const presentByCampaign = new Map();
  for (const a of assets) {
    const key = a.campaignId || a.campaignName;
    if (!key) continue;
    if (!presentByCampaign.has(key)) presentByCampaign.set(key, new Set());
    if (a.fieldType) presentByCampaign.get(key).add(String(a.fieldType).toUpperCase());
  }

  const isSearch = (objective) => text(objective).includes("search");

  const candidates = [];
  for (const c of campaigns) {
    if (isPausedStatus(c.status)) continue;
    if (!isSearch(c.objective)) continue; // extensions matter most on Search
    const spend = numberValue(c.spend);
    if (spend < EXT_MIN_SPEND) continue;
    const key = c.campaignId || c.name;
    const present = presentByCampaign.get(key) || new Set();
    const missing = CORE_EXTENSION_TYPES.filter((t) => !present.has(t));
    const noSitelinks = !present.has("SITELINK");
    if (noSitelinks || missing.length >= 2) {
      candidates.push({ name: c.name || "(unnamed campaign)", spend, missing, noSitelinks });
    }
  }
  if (candidates.length === 0) return;

  const worst = candidates.sort((a, b) => b.spend - a.spend)[0];
  const affectedSpend = candidates.reduce((s, c) => s + c.spend, 0);
  const more = candidates.length - 1;
  const niceMissing = worst.missing
    .map((t) => t.toLowerCase().replace(/_/g, " "))
    .join(", ");

  findings.push(
    createFinding({
      ruleId: "GOOGLE-EXT-001",
      platform: "GOOGLE",
      severity: worst.noSitelinks ? "MEDIUM" : "LOW",
      category: "Ad Copy & Extensions",
      title: `${worst.name} runs ${fmt(worst.spend)} of Search spend ${worst.noSitelinks ? "with no sitelinks" : `missing ${worst.missing.length} core extension types`}`,
      detail: `${worst.name} spends ${fmt(worst.spend)} on Search but is missing ${niceMissing || "core extensions"}. Extensions (sitelinks, callouts, structured snippets) add free SERP real estate and consistently lift CTR at the same CPC — their absence leaves easy click volume on the table.${more > 0 ? ` ${more} other Search campaign${more === 1 ? "" : "s"} show the same gap.` : ""}`,
      rootCause: `Core ad extensions aren't applied to this Search campaign, so its ads occupy less of the results page and earn fewer clicks than competitors at the same bid.`,
      evidence: {
        campaign: worst.name,
        spend: Math.round(worst.spend),
        missingExtensionTypes: worst.missing,
        hasSitelinks: !worst.noSitelinks,
        affectedCampaignCount: candidates.length,
        affectedSpend: Math.round(affectedSpend),
        confidence: "high",
        minSamplePassed: true,
      },
      estimatedImpact: `Adding the missing extensions typically lifts CTR several percent at the same CPC — more clicks from the budget already spent on ${worst.name}.`,
      fixSteps: [
        `Add at least 4 sitelinks, 4 callouts, and 1–2 structured snippets to ${worst.name}.`,
        "Apply core extensions at the account level so new campaigns inherit them by default.",
        "Review extension performance after a cycle and keep the highest-CTR variants.",
      ],
    })
  );
};

const calculateScores = ({ audit, findings }) => {
  const platforms = {};

  for (const platform of audit.selectedPlatforms) {
    const platformFindings = findings.filter((finding) => finding.platform === platform);
    const categoryWeights = PLATFORM_CATEGORIES[platform];
    const categories = {};

    for (const category of Object.keys(categoryWeights)) {
      const categoryFindings = platformFindings.filter(
        (finding) => finding.category === category
      );
      const penalty = categoryFindings.reduce(
        (total, finding) => total + SEVERITY_PENALTIES[finding.severity],
        0
      );

      categories[category] = Math.max(0, 100 - penalty);
    }

    const weightedScore =
      Object.entries(categories).reduce(
        (total, [category, score]) => total + score * categoryWeights[category],
        0
      ) / Object.values(categoryWeights).reduce((total, weight) => total + weight, 0);

    // The category scores already bake in severity penalties. The old global
    // `100 - totalPenalty` cap applied them a SECOND time and, because the engine
    // now surfaces one root problem as several overlapping findings, it stacked
    // past 100 and floored otherwise-healthy accounts to 0. Instead, apply a small
    // density penalty for unresolved critical/high findings, CAPPED so overlapping
    // findings can't sink a peer-beating account.
    const criticalCount = platformFindings.filter((f) => f.severity === "CRITICAL").length;
    const highCount = platformFindings.filter((f) => f.severity === "HIGH").length;
    const densityPenalty = Math.min(6 * criticalCount + 3 * highCount, 25);

    platforms[platform] = {
      score: Math.round(Math.max(0, Math.min(100, weightedScore - densityPenalty))),
      categories,
      findingCount: platformFindings.length,
    };
  }

  const overall =
    Object.values(platforms).reduce((total, platform) => total + platform.score, 0) /
    Math.max(1, Object.keys(platforms).length);

  return {
    overall: Math.round(overall),
    platforms,
  };
};

const buildDeterministicSummary = ({ audit, dataset, findings, scores }) => {
  // Leverage order: severity → confidence → recoverable dollars, with ruleId as
  // the final deterministic tiebreak (see lib/findings/priority.js).
  const sortedFindings = [...findings].sort(
    (left, right) =>
      byLeverageDesc(left, right) || left.ruleId.localeCompare(right.ruleId)
  );
  const totals = dataset.summary?.totals || {};

  return {
    executiveSummary: [
      `This deterministic audit reviewed ${audit.selectedPlatforms
        .map((platform) => PLATFORM_LABELS[platform])
        .join(", ")} using ${audit.dataSource !== "MANUAL_UPLOAD" ? "live API data" : "validated upload data"} and intake answers.`,
      audit.uploadReadiness?.mode === "FULL"
        ? `Data coverage is complete: all required platform reports were ${audit.dataSource !== "MANUAL_UPLOAD" ? "fetched via OAuth API" : "validated"}.`
        : "Upload readiness is limited: the audit ran with partial data and should be treated as directional until missing reports are uploaded.",
      `The current health score is ${scores.overall}/100. The engine found ${findings.length} issue(s), with ${sortedFindings.filter((finding) => finding.severity === "CRITICAL").length} critical and ${sortedFindings.filter((finding) => finding.severity === "HIGH").length} high-priority item(s).`,
      `Data covers ${totals.uploadedFiles || 0} source(s), ${totals.rowCount || 0} row(s), and ${Math.round(totals.spend || 0).toLocaleString()} in detected spend.`,
    ],
    topPriorities: sortedFindings.slice(0, 5).map((finding) => ({
      ruleId: finding.ruleId,
      platform: finding.platform,
      severity: finding.severity,
      title: finding.title,
      estimatedImpact: finding.estimatedImpact,
    })),
    quickWins: sortedFindings
      .filter((finding) => ["MEDIUM", "LOW"].includes(finding.severity))
      .slice(0, 5)
      .map((finding) => ({
        ruleId: finding.ruleId,
        platform: finding.platform,
        title: finding.title,
        fixSteps: finding.fixSteps,
      })),
  };
};

/**
 * Re-apply pull-time normalization that the stored dataset may predate. Audit
 * runs reuse the stored dataset (they don't re-pull), so improvements to
 * normalization would otherwise never reach already-connected accounts. Currently
 * re-runs ad-set→campaign messaging reconciliation; idempotent (a no-op once the
 * dataset is already reconciled). Mutates the dataset in place and keeps the
 * platform/total conversion counts consistent with the corrected campaign results.
 */
const refreshStoredNormalization = (dataset) => {
  const meta = dataset?.data?.platforms?.META;
  const campaigns = meta?.byLevel?.campaign;
  const adsets = meta?.byLevel?.adset;
  if (!Array.isArray(campaigns) || !Array.isArray(adsets) || adsets.length === 0) return;

  const reconciled = reconcileCampaignResultsFromAdSets(campaigns, adsets);
  let convDelta = 0;
  for (let i = 0; i < reconciled.length; i++) {
    if (reconciled[i] !== campaigns[i]) {
      convDelta += numberValue(reconciled[i].results) - numberValue(campaigns[i].results);
    }
  }
  if (convDelta === 0) return; // already reconciled, or nothing to correct

  meta.byLevel.campaign = reconciled;
  // Keep the flat records array in sync (some Meta rules read it directly).
  if (Array.isArray(meta.records)) {
    const reconciledSet = new Set(campaigns);
    const map = new Map(campaigns.map((c, i) => [c, reconciled[i]]));
    meta.records = meta.records.map((r) => (reconciledSet.has(r) ? map.get(r) : r));
  }
  // Corrected results must flow into the conversion totals the baseline reads.
  const sum = dataset.summary?.platforms?.META;
  if (sum) sum.conversions = numberValue(sum.conversions) + convDelta;
  const totals = dataset.summary?.totals;
  if (totals && Number.isFinite(numberValue(totals.conversions))) {
    totals.conversions = numberValue(totals.conversions) + convDelta;
  }
};

export const runDeterministicAudit = (audit) => {
  const dataset = audit.normalizedDataset;

  if (!dataset) {
    return {
      findings: [],
      scores: { overall: 0, platforms: {} },
      report: {
        executiveSummary: ["No normalized dataset is available for this audit."],
        topPriorities: [],
        quickWins: [],
      },
    };
  }

  const findings = [];

  // Re-apply normalization that improved after this dataset was pulled. Audit runs
  // reuse the STORED dataset and never re-pull, so a fix that lived only at pull
  // time (e.g. messaging-result reconciliation) would never reach an
  // already-connected account. Running it here self-heals on every audit.
  refreshStoredNormalization(dataset);

  // Runs first: stamps the anomaly-quarantined ("trusted") baseline on each
  // platform summary so every downstream efficiency rule is judged against the
  // real baseline, not one collapsed by fake-cheap conversions.
  addConversionAnomalyFindings({ audit, dataset, findings });

  if (audit.selectedPlatforms.includes("META")) {
    addMetaFindings({ audit, dataset, findings });
  }
  if (audit.selectedPlatforms.includes("GOOGLE")) {
    addGoogleFindings({ audit, dataset, findings });
  }
  if (audit.selectedPlatforms.includes("TIKTOK")) {
    addTikTokFindings({ audit, dataset, findings });
  }
  addDataQualityFindings({ audit, dataset, findings });
  addBusinessProfileFindings({ audit, dataset, findings });
  addBenchmarkFindings({ audit, dataset, findings });
  addOpportunityFindings({ audit, dataset, findings });
  addSegmentFindings({ audit, dataset, findings });
  addMetaEfficiencyFindings({ audit, dataset, findings }); // after SEG-WASTE: skips its segments
  addMetaPolicyFindings({ audit, dataset, findings });
  addMetaGeoFindings({ audit, dataset, findings });
  addMetaBiddingFindings({ audit, dataset, findings });
  addMetaHygieneFindings({ audit, dataset, findings });
  addMetaFrequencyFindings({ audit, dataset, findings });
  addMetaFunnelFindings({ audit, dataset, findings });
  addCampaignDecompositionFindings({ audit, dataset, findings });
  addMetaAdSetDispersionFindings({ audit, dataset, findings });
  addTikTokAdGroupDispersionFindings({ audit, dataset, findings });
  addGoogleBiddingFindings({ audit, dataset, findings });
  addGoogleBidTargetFindings({ audit, dataset, findings });
  addGoogleAudienceFindings({ audit, dataset, findings });
  addGoogleSearchTermFindings({ audit, dataset, findings });
  addGoogleAudienceFragmentationFindings({ audit, dataset, findings });
  addGoogleDeviceFindings({ audit, dataset, findings });
  addGoogleLandingPageFindings({ audit, dataset, findings });
  addGoogleGeoFindings({ audit, dataset, findings });
  addGoogleGeoBleedFindings({ audit, dataset, findings });
  addGoogleImpressionShareFindings({ audit, dataset, findings });
  addGoogleConversionTrackingFindings({ audit, dataset, findings });
  addGoogleAdStrengthFindings({ audit, dataset, findings });
  addGoogleAllocationFindings({ audit, dataset, findings });
  addGoogleHygieneFindings({ audit, dataset, findings });
  addGoogleExtensionFindings({ audit, dataset, findings });
  addCompoundFindings({ audit, findings });

  // Re-label money to the account's real currency BEFORE the summary is built,
  // so executive summary + priorities (which copy finding copy) inherit it.
  localizeFindingsCurrency(findings, dataset);

  // Collapse cross-level dispersion duplicates (e.g. a campaign and its lone ad
  // set surfacing the same waste) before scoring — so a duplicate CRITICAL does
  // not double-count in the density penalty or the presented list.
  const collapsed = collapseOverlappingFindings(findings);

  // Trust layer — ONE general gate every finding passes through before it may
  // assert a recoverable number: drops attribution artifacts / implausible CPAs,
  // hedges thin-sample findings, and assigns each a non-overlapping
  // `evidence.netRecoverable` so the report body can never sum past the headline.
  const finalFindings = applyTrustLayer({ findings: collapsed, dataset });

  const scores = calculateScores({ audit, findings: finalFindings });
  const report = buildDeterministicSummary({ audit, dataset, findings: finalFindings, scores });

  return {
    findings: finalFindings,
    scores,
    report,
  };
};
