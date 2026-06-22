/**
 * Overlap-aware recoverable total.
 *
 * The audit now surfaces the same wasted spend from several angles: a campaign
 * runs far over baseline (CAMP-CPA), the audience inside it is mis-applied
 * (GOOGLE-AUD), a device inside it converts at zero (GOOGLE-DEVICE), and the
 * country it targets leaks (GOOGLE-GEO). These are the SAME dollars viewed
 * through different lenses — naively summing their "recoverable" figures inflates
 * the headline 2-3×. This reconciles them into non-overlapping spend pools and
 * counts each dollar once:
 *
 *   - Campaign-scoped findings (campaign / ad-set / ad-group dispersion, audience,
 *     device) nest inside one campaign → grouped by campaign, count the LARGEST
 *     (the parent dispersion figure already contains the audience/device subset).
 *   - A geo finding is merged into a campaign group when the country matches that
 *     campaign's name (single-region-per-campaign accounts), else counted on its
 *     own.
 *   - Cross-cutting cuts (day-of-week, age, gender, …) are distinct optimisation
 *     levers → counted once each.
 *   - A backstop caps the total at a sane share of reviewed spend.
 *
 * Pure + deterministic → unit-testable without a DB or LLM.
 */

import { parseImpactDollars } from "./priority.js";

// Country name → tokens that might appear in a campaign name (ISO code,
// abbreviation, full name). Extend as needed; unknown countries fall back to the
// country string itself.
export const COUNTRY_TOKENS = {
  pakistan: ["pk", "pak", "pakistan"],
  india: ["in", "ind", "india"],
  bangladesh: ["bd", "ban", "bgd", "bangladesh"],
  "united arab emirates": ["ae", "uae", "emirates"],
  "saudi arabia": ["sa", "ksa", "saudi"],
  "united states": ["us", "usa", "united states", "america"],
  "united kingdom": ["uk", "gb", "gbr", "britain", "united kingdom"],
  canada: ["ca", "can", "canada"],
  australia: ["au", "aus", "australia"],
  indonesia: ["id", "idn", "indonesia"],
  malaysia: ["my", "mys", "malaysia"],
  philippines: ["ph", "phl", "philippines"],
  nigeria: ["ng", "nga", "nigeria"],
  egypt: ["eg", "egy", "egypt"],
  "south africa": ["za", "zaf", "south africa"],
  brazil: ["br", "bra", "brazil"],
  mexico: ["mx", "mex", "mexico"],
  turkey: ["tr", "tur", "turkey", "turkiye"],
  germany: ["de", "deu", "germany"],
  france: ["fr", "fra", "france"],
  spain: ["es", "esp", "spain"],
};

export const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
export const tokenize = (s) => norm(s).split(/[^a-z0-9]+/).filter(Boolean);

/**
 * Does a geo finding's country belong to (i.e. is it the same spend pool as) a
 * campaign whose name carries the country token? e.g. country "Pakistan" matches
 * campaign "Display | PK | Signals" via the "pk" token. Shared by the headline
 * reconcile and the displayed-finding collapse so both agree on overlap.
 */
export const geoMatchesEntity = (country, entityName) => {
  const c = norm(country);
  if (!c || !entityName) return false;
  const tokens = COUNTRY_TOKENS[c] || [c];
  const entityTokens = new Set(tokenize(entityName));
  return tokens.some((t) => entityTokens.has(t));
};

const CAMPAIGN_SCOPED = /^(CAMP-CPA|GOOGLE-AUD|GOOGLE-DEVICE|META-ADSET|TIKTOK-ADGROUP)/;
const GEO_SCOPED = /(GOOGLE|META)-GEO/;
const SEGMENT_SCOPED = /^SEG-WASTE/;
// Audience/placement-type segment slices (placement, age, gender, device,
// region) are re-slices of the SAME spend the campaign dispersion already
// measures — the same rupees, cut by audience instead of by campaign. They must
// merge into the inefficiency pool, not stack on it. Temporal levers
// (day-of-week, hour) are genuinely independent optimisation knobs → still
// additive.
const AUDIENCE_DIMENSION_RX = /placement|age|gender|device|region|countr|audience|geo|dma|city|metro/i;

const campaignOf = (finding) => {
  const ev = finding?.evidence || {};
  return ev.worstEntity || ev.worstCampaign || ev.campaign || null;
};

const recoverableOf = (finding) => parseImpactDollars(finding?.estimatedImpact);

/**
 * @param {Array}  findings
 * @param {object} opts
 * @param {number} [opts.accountSpend]  reviewed spend — backstop cap basis
 * @param {number} [opts.capFraction]   max share of spend treated as recoverable (default 0.6)
 * @returns {{ total, groupCount, overlapping, capped, groups }}
 */
export const reconcileRecoverable = (findings = [], { accountSpend = 0, capFraction = 0.6 } = {}) => {
  const quantified = (findings || [])
    .map((f) => ({ finding: f, amount: recoverableOf(f) }))
    .filter((x) => x.amount > 0);

  const campaignGroups = []; // { campaign, tokens:Set, amount }
  const otherGroups = []; // { key, amount }

  const findCampaignGroup = (campaign) =>
    campaignGroups.find((g) => norm(g.campaign) === norm(campaign));

  // 1. Campaign-scoped findings → group by campaign, keep the largest (nested).
  for (const { finding, amount } of quantified) {
    if (!CAMPAIGN_SCOPED.test(finding.ruleId || "")) continue;
    const campaign = campaignOf(finding);
    if (!campaign) {
      otherGroups.push({ key: `${finding.ruleId}:${finding.title}`, amount });
      continue;
    }
    let g = findCampaignGroup(campaign);
    if (!g) {
      g = { campaign, tokens: new Set(tokenize(campaign)), amount: 0 };
      campaignGroups.push(g);
    }
    g.amount = Math.max(g.amount, amount);
  }

  // 2. Geo findings → merge into the matching campaign group, else own group.
  // A geo leak is almost always a subset of some campaign's waste (the wrong-
  // country spend IS the zero-conversion campaign). Match by country name token
  // first; when the campaign isn't named with its country (e.g. "Kingdom
  // Testing" delivering to GB), fall back to merging into the largest campaign
  // group it could be a subset of, so the same dollars aren't counted twice.
  for (const { finding, amount } of quantified) {
    if (!GEO_SCOPED.test(finding.ruleId || "")) continue;
    const country = norm(finding.evidence?.country);
    const countryTokens = COUNTRY_TOKENS[country] || (country ? [country] : []);
    let match = campaignGroups.find((g) => countryTokens.some((t) => g.tokens.has(t)));
    if (!match && campaignGroups.length) {
      // No country token in any campaign name (e.g. "Kingdom Testing" → GB). The
      // leak is still a subset of campaign waste, so fold it into the largest
      // campaign group rather than counting the same dollars twice.
      match = campaignGroups.reduce((a, b) => (b.amount > a.amount ? b : a));
    }
    if (match) {
      match.amount = Math.max(match.amount, amount);
    } else {
      otherGroups.push({ key: `geo:${country}`, amount });
    }
  }

  // 3. Everything else. Audience/placement segment slices overlap the campaign
  // pool (same spend, sliced differently) → pooled and counted ONCE via the max.
  // Genuinely-independent levers (day-of-week, benchmark CPM, …) stay additive.
  const audienceSegmentAmounts = [];
  for (const { finding, amount } of quantified) {
    const rid = finding.ruleId || "";
    if (CAMPAIGN_SCOPED.test(rid) || GEO_SCOPED.test(rid)) continue;
    if (SEGMENT_SCOPED.test(rid) && AUDIENCE_DIMENSION_RX.test(String(finding.evidence?.dimension || ""))) {
      audienceSegmentAmounts.push(amount);
      continue;
    }
    otherGroups.push({ key: `${rid}:${finding.title}`, amount });
  }

  const campaignTotal = campaignGroups.reduce((s, g) => s + g.amount, 0);
  const otherTotal = otherGroups.reduce((s, g) => s + g.amount, 0);
  const audienceMax = audienceSegmentAmounts.length ? Math.max(...audienceSegmentAmounts) : 0;

  // The inefficiency pool — per-campaign dispersion and per-audience-segment skew
  // are overlapping measures of the same excess-over-baseline spend. Count the
  // larger, never the sum, so the headline can't claim the same rupee twice.
  const inefficiency = Math.max(campaignTotal, audienceMax);
  let total = inefficiency + otherTotal;

  const cap = accountSpend > 0 ? accountSpend * capFraction : Infinity;
  const capped = Number.isFinite(cap) && total > cap;
  if (capped) total = cap;

  const distinctPools = campaignGroups.length + otherGroups.length + (audienceSegmentAmounts.length ? 1 : 0);
  return {
    total: Math.round(total),
    groupCount: distinctPools,
    overlapping: quantified.length > distinctPools,
    capped,
  };
};
