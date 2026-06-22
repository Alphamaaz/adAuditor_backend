/**
 * Overlap-aware recoverable accounting.
 *
 * The audit surfaces the same wasted spend from several angles: a campaign runs
 * far over baseline (CAMP-CPA), the audience inside it is mis-applied
 * (GOOGLE-AUD), a device inside it converts at zero (GOOGLE-DEVICE), the country
 * it targets leaks (GOOGLE-GEO), or a placement/age slice of it skews
 * (SEG-WASTE). These are the SAME dollars viewed through different lenses —
 * naively summing their "recoverable" figures inflates the headline 2-3× (real
 * accounts were claiming 60-141% of total spend as recoverable).
 *
 * `partitionRecoverable` is the single source of truth. It splits findings into
 * non-overlapping spend pools and assigns each finding a NET recoverable:
 *   - Campaign-scoped findings (campaign / ad-set / ad-group dispersion, audience,
 *     device) nest inside one campaign → grouped by campaign; the LARGEST is the
 *     pool's carrier (it already contains the audience/device subset), the rest
 *     net to 0.
 *   - A geo finding merges into the campaign whose name carries its country token
 *     (single-region-per-campaign accounts), else the largest campaign group, else
 *     its own independent pool.
 *   - Audience/placement/region SEG-WASTE slices re-cut the SAME spend the
 *     campaign dispersion already measures → pooled and counted ONCE (the max),
 *     never stacked on the campaign total.
 *   - Genuinely independent levers (day-of-week, hour, benchmark CPM, …) are
 *     distinct optimisation knobs → each keeps its own net.
 *   - A backstop caps the total at a sane share of reviewed spend; when it bites,
 *     every per-finding net is scaled proportionally so the body still reconciles
 *     with the headline.
 *
 * `reconcileRecoverable` is the thin headline wrapper (sum of the nets, capped).
 * The trust layer writes each net onto `evidence.netRecoverable` so the report's
 * money-map and per-finding annotations show the SAME non-overlapping figures —
 * the body can never again contradict the headline.
 *
 * Pure + deterministic → unit-testable without a DB or LLM.
 */

import { parseImpactDollars } from "./priority.js";

// Country name → tokens that might appear in a campaign name (ISO code,
// abbreviation, full name), used ONLY to merge a geo finding into the campaign
// that targets that country (so the same spend isn't counted twice). Unlisted
// countries degrade gracefully — they fall back to merging into the largest
// campaign pool or standing alone, so missing a country is never a correctness
// bug, just slightly less precise. 2-letter ISO codes that are common English
// words ("no"/Norway, "is"/Iceland, "it"/Italy, "be"/Belgium, "at"/Austria,
// "co"/Colombia, "per"/Peru) are deliberately omitted to avoid matching prose.
export const COUNTRY_TOKENS = {
  // South Asia
  pakistan: ["pk", "pak", "pakistan"],
  india: ["in", "ind", "india"],
  bangladesh: ["bd", "ban", "bgd", "bangladesh"],
  "sri lanka": ["lk", "lka", "sri lanka", "srilanka"],
  nepal: ["np", "npl", "nepal"],
  // Southeast / East Asia + Pacific
  indonesia: ["id", "idn", "indonesia"],
  malaysia: ["my", "mys", "malaysia"],
  philippines: ["ph", "phl", "philippines"],
  thailand: ["th", "tha", "thailand"],
  vietnam: ["vn", "vnm", "vietnam"],
  singapore: ["sg", "sgp", "singapore"],
  japan: ["jp", "jpn", "japan"],
  china: ["cn", "chn", "china"],
  "hong kong": ["hk", "hkg", "hong kong", "hongkong"],
  taiwan: ["tw", "twn", "taiwan"],
  "south korea": ["kr", "kor", "korea", "south korea"],
  australia: ["au", "aus", "australia"],
  "new zealand": ["nz", "nzl", "new zealand"],
  // Middle East
  "united arab emirates": ["ae", "uae", "emirates"],
  "saudi arabia": ["sa", "ksa", "saudi"],
  qatar: ["qa", "qat", "qatar"],
  kuwait: ["kw", "kwt", "kuwait"],
  bahrain: ["bh", "bhr", "bahrain"],
  oman: ["om", "omn", "oman"],
  jordan: ["jo", "jor", "jordan"],
  israel: ["il", "isr", "israel"],
  turkey: ["tr", "tur", "turkey", "turkiye"],
  // Africa
  nigeria: ["ng", "nga", "nigeria"],
  egypt: ["eg", "egy", "egypt"],
  "south africa": ["za", "zaf", "south africa"],
  kenya: ["ke", "ken", "kenya"],
  ghana: ["gh", "gha", "ghana"],
  morocco: ["mar", "morocco"],
  tunisia: ["tn", "tun", "tunisia"],
  // North America
  "united states": ["us", "usa", "united states", "america"],
  canada: ["ca", "can", "canada"],
  mexico: ["mx", "mex", "mexico"],
  // South America
  brazil: ["br", "bra", "brazil"],
  argentina: ["arg", "argentina"],
  chile: ["cl", "chl", "chile"],
  colombia: ["col", "colombia"],
  peru: ["pe", "peru"],
  // Europe
  "united kingdom": ["uk", "gb", "gbr", "britain", "united kingdom"],
  ireland: ["ie", "irl", "ireland"],
  germany: ["de", "deu", "germany"],
  france: ["fr", "fra", "france"],
  spain: ["es", "esp", "spain"],
  italy: ["ita", "italy"],
  portugal: ["pt", "prt", "portugal"],
  netherlands: ["nl", "nld", "netherlands", "holland"],
  belgium: ["bel", "belgium"],
  switzerland: ["ch", "che", "switzerland", "swiss"],
  austria: ["aut", "austria"],
  sweden: ["se", "swe", "sweden"],
  norway: ["nor", "norway"],
  denmark: ["dk", "dnk", "denmark"],
  finland: ["fi", "fin", "finland"],
  poland: ["pl", "pol", "poland"],
  greece: ["gr", "grc", "greece"],
  "czech republic": ["cz", "cze", "czech", "czechia"],
  romania: ["ro", "rou", "romania"],
  ukraine: ["ua", "ukr", "ukraine"],
  russia: ["ru", "rus", "russia"],
};

// Defensive backstop: the most of reviewed spend we will ever present as
// "recoverable". Post-reconciliation real accounts land at 11-47%, so this rarely
// binds — it exists to clamp pathological accounts (and is deliberately below the
// old 0.6: claiming you can recover half the budget is already very aggressive).
export const RECOVERABLE_CAP_FRACTION = 0.5;

export const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
export const tokenize = (s) => norm(s).split(/[^a-z0-9]+/).filter(Boolean);

/**
 * Does a geo finding's country belong to (i.e. is it the same spend pool as) a
 * campaign whose name carries the country token? e.g. country "Pakistan" matches
 * campaign "Display | PK | Signals" via the "pk" token.
 */
export const geoMatchesEntity = (country, entityName) => {
  const c = norm(country);
  if (!c || !entityName) return false;
  const tokens = COUNTRY_TOKENS[c] || [c];
  const entityTokens = new Set(tokenize(entityName));
  return tokens.some((t) => entityTokens.has(t));
};

export const CAMPAIGN_SCOPED = /^(CAMP-CPA|GOOGLE-AUD|GOOGLE-DEVICE|META-ADSET|TIKTOK-ADGROUP)/;
export const GEO_SCOPED = /(GOOGLE|META)-GEO/;
export const SEGMENT_SCOPED = /^SEG-WASTE/;
// Audience/placement-type segment slices (placement, age, gender, device,
// region) are re-slices of the SAME spend the campaign dispersion already
// measures — the same rupees, cut by audience instead of by campaign. They merge
// into the inefficiency pool, not stack on it. Temporal levers (day-of-week,
// hour) are genuinely independent optimisation knobs → still additive.
export const AUDIENCE_DIMENSION_RX = /placement|age|gender|device|region|countr|audience|geo|dma|city|metro/i;

const campaignOf = (finding) => {
  const ev = finding?.evidence || {};
  return ev.worstEntity || ev.worstCampaign || ev.campaign || null;
};

const recoverableOf = (finding) => parseImpactDollars(finding?.estimatedImpact);

const isAudienceSegment = (finding) =>
  SEGMENT_SCOPED.test(finding?.ruleId || "") &&
  AUDIENCE_DIMENSION_RX.test(String(finding?.evidence?.dimension || ""));

/**
 * The campaigns whose excess a dispersion finding (CAMP-CPA / META-ADSET / …)
 * actually COUNTS in its recoverable — the top `outlierCount` entities by
 * multiple-of-baseline from its entityBreakdown. A device/audience/geo finding on
 * ANY of these is the same spend the dispersion already counts, so it must merge
 * in rather than stack on top. (Before this, only the single worst campaign was
 * recognised, so a device leak on the 2nd-worst campaign double-counted.) Returns
 * [] for non-dispersion findings, leaving them to match by their own name only.
 */
const coveredCampaigns = (finding) => {
  const ev = finding?.evidence || {};
  const bd = Array.isArray(ev.entityBreakdown) ? ev.entityBreakdown : null;
  if (!bd || !bd.length) return [];
  const n = Number.isFinite(ev.outlierCount) ? ev.outlierCount : bd.length;
  return bd
    .map((x) => ({
      name: x.entity || x.name,
      mult: Number(x.mult ?? x.multiple ?? x.multipleOfBaseline) || 0,
    }))
    .filter((x) => x.name)
    .sort((a, b) => b.mult - a.mult)
    .slice(0, Math.max(n, 1))
    .map((x) => norm(x.name));
};

/**
 * Split findings into non-overlapping pools and assign each a net recoverable.
 *
 * @param {Array}  findings
 * @param {object} opts
 * @param {number} [opts.accountSpend]  reviewed spend — backstop cap basis
 * @param {number} [opts.capFraction]   max share of spend treated as recoverable (default 0.6)
 * @returns {{ total, capped, overlapping, groupCount, assignments }}
 *   assignments: Array<{ finding, net, role: 'primary'|'secondary'|'independent' }>
 */
export const partitionRecoverable = (
  findings = [],
  { accountSpend = 0, capFraction = RECOVERABLE_CAP_FRACTION } = {}
) => {
  const quantified = (findings || [])
    .map((f) => ({ finding: f, amount: recoverableOf(f) }))
    .filter((x) => x.amount > 0);

  // Every quantified finding defaults to secondary/0; pool carriers get promoted.
  const roleOf = new Map(quantified.map((x) => [x.finding, { net: 0, role: "secondary" }]));

  const campaignGroups = []; // { names:Set, tokens:Set, amount, carrier }
  const independents = []; // { finding, amount }  — distinct levers, counted on their own
  const audienceMembers = []; // { finding, amount } — re-slices of the campaign pool
  const groupForCampaign = (c) => campaignGroups.find((g) => g.names.has(norm(c)));
  const promote = (g, finding, amount) => {
    if (amount > g.amount) {
      g.amount = amount;
      g.carrier = finding;
    }
  };

  // 1. Campaign-scoped findings → grouped by the campaign they touch. Dispersion
  // findings (which carry an entityBreakdown) go FIRST so each pool knows the full
  // set of campaigns whose excess it counts; device/audience/geo findings on any
  // of those campaigns then merge into the pool instead of stacking on it.
  const campaignScoped = quantified.filter((x) => CAMPAIGN_SCOPED.test(x.finding.ruleId || ""));
  const ordered = [
    ...campaignScoped.filter((x) => Array.isArray(x.finding.evidence?.entityBreakdown)),
    ...campaignScoped.filter((x) => !Array.isArray(x.finding.evidence?.entityBreakdown)),
  ];
  for (const { finding, amount } of ordered) {
    const campaign = campaignOf(finding);
    if (!campaign) {
      independents.push({ finding, amount });
      continue;
    }
    const covered = [norm(campaign), ...coveredCampaigns(finding)];
    let g = campaignGroups.find((gr) => covered.some((c) => gr.names.has(c)));
    if (!g) {
      g = { names: new Set(), tokens: new Set(), amount: 0, carrier: null };
      campaignGroups.push(g);
    }
    for (const c of covered) g.names.add(c);
    for (const t of tokenize(campaign)) g.tokens.add(t);
    promote(g, finding, amount);
  }

  // 2. Geo findings → merge into the matching campaign pool (same dollars), else
  // the largest campaign pool, else their own independent pool.
  for (const { finding, amount } of quantified) {
    if (!GEO_SCOPED.test(finding.ruleId || "")) continue;
    const country = norm(finding.evidence?.country);
    const countryTokens = COUNTRY_TOKENS[country] || (country ? [country] : []);
    let match = campaignGroups.find((g) => countryTokens.some((t) => g.tokens.has(t)));
    if (!match && campaignGroups.length) {
      match = campaignGroups.reduce((a, b) => (b.amount > a.amount ? b : a));
    }
    if (match) {
      if (amount > match.amount) {
        match.amount = amount;
        match.carrier = finding;
      }
    } else {
      independents.push({ finding, amount });
    }
  }

  // 3. Audience/placement/region SEG-WASTE slices → pooled (max), counted once.
  // Distinct temporal/benchmark levers → independent.
  for (const { finding, amount } of quantified) {
    const rid = finding.ruleId || "";
    if (CAMPAIGN_SCOPED.test(rid) || GEO_SCOPED.test(rid)) continue;
    if (isAudienceSegment(finding)) {
      audienceMembers.push({ finding, amount });
    } else {
      independents.push({ finding, amount });
    }
  }

  const campaignTotal = campaignGroups.reduce((s, g) => s + g.amount, 0);
  let audienceCarrier = null;
  let audienceMax = 0;
  for (const m of audienceMembers) {
    if (m.amount > audienceMax) {
      audienceMax = m.amount;
      audienceCarrier = m.finding;
    }
  }

  // The inefficiency pool — per-campaign dispersion and per-audience-segment skew
  // are overlapping measures of the same excess-over-baseline spend. Count the
  // larger side, never the sum.
  if (campaignTotal >= audienceMax) {
    for (const g of campaignGroups) {
      if (g.carrier) roleOf.set(g.carrier, { net: g.amount, role: "primary" });
    }
    // audience members stay secondary/0 (redundant with the campaign pool)
  } else if (audienceCarrier) {
    roleOf.set(audienceCarrier, { net: audienceMax, role: "primary" });
    // campaign carriers stay secondary/0 (the audience slice dominates the pool)
  }

  for (const { finding, amount } of independents) {
    roleOf.set(finding, { net: amount, role: "independent" });
  }

  const inefficiency = Math.max(campaignTotal, audienceMax);
  const independentTotal = independents.reduce((s, x) => s + x.amount, 0);
  const uncapped = inefficiency + independentTotal;

  const cap = accountSpend > 0 ? accountSpend * capFraction : Infinity;
  const capped = Number.isFinite(cap) && uncapped > cap;
  const total = capped ? cap : uncapped;

  // When the cap bites, scale every net proportionally so the per-finding figures
  // still sum to the (capped) headline — the body can't exceed it.
  if (capped && uncapped > 0) {
    const scale = cap / uncapped;
    for (const [finding, v] of roleOf) {
      roleOf.set(finding, { net: v.net * scale, role: v.role });
    }
  }

  const distinctPools =
    campaignGroups.length + independents.length + (audienceMembers.length ? 1 : 0);

  const assignments = quantified.map(({ finding }) => {
    const v = roleOf.get(finding);
    return { finding, net: Math.round(v.net), role: v.role };
  });

  return {
    total: Math.round(total),
    capped,
    overlapping: quantified.length > distinctPools,
    groupCount: distinctPools,
    assignments,
  };
};

/**
 * Headline recoverable — the sum of the non-overlapping nets, capped.
 *
 * Once findings have passed through the trust layer they each carry an authored
 * `evidence.netRecoverable` (non-overlapping by construction). Prefer it so the
 * headline equals the sum of the per-finding figures the report body shows — the
 * two can never diverge. Raw findings (pre-trust-layer, e.g. unit fixtures) fall
 * back to re-deriving the pools from the estimatedImpact text.
 */
export const reconcileRecoverable = (findings = [], opts = {}) => {
  const list = findings || [];
  const hasNet = list.some((f) => Number.isFinite(f?.evidence?.netRecoverable));
  if (hasNet) {
    const { accountSpend = 0, capFraction = RECOVERABLE_CAP_FRACTION } = opts;
    const raw = list.reduce(
      (s, f) => s + (Number.isFinite(f?.evidence?.netRecoverable) ? f.evidence.netRecoverable : 0),
      0
    );
    const cap = accountSpend > 0 ? accountSpend * capFraction : Infinity;
    const capped = Number.isFinite(cap) && raw > cap;
    return { total: Math.round(capped ? cap : raw), groupCount: list.length, overlapping: false, capped };
  }
  const { total, capped, overlapping, groupCount } = partitionRecoverable(list, opts);
  return { total, groupCount, overlapping, capped };
};
