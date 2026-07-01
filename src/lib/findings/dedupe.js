/**
 * Collapse findings that describe the SAME wasted spend at different entity
 * levels into a single, most-actionable finding.
 *
 * The dispersion rules run independently per level: CAMP-CPA-001 ranks campaigns,
 * META-ADSET-001 ranks ad sets, TIKTOK-ADGROUP-001 ranks ad groups. Ad sets nest
 * inside campaigns, so on the same platform these are two views of the SAME
 * spend hierarchy — and they can report DIFFERENT aggregate amounts (the ad-set
 * pass may sweep up more low-sample outliers). A live report showed a campaign
 * dispersion (PKR 3,188) and an ad-set dispersion (PKR 9,303) double-listed and
 * double-counted. So per platform we keep only ONE dispersion finding — the most
 * actionable (campaign level), breaking ties by confidence then amount.
 *
 * (reconcileRecoverable de-dups the headline by amount; this de-dups the
 * PRESENTED list and the severity counts that drive the health-score density
 * penalty. Run before scoring + reporting.)
 *
 * Pure + deterministic.
 */

import { parseImpactDollars } from "./priority.js";
import { geoMatchesEntity } from "./recoverable.js";

// Same wasted spend, surfaced at different levels. Higher rank = more actionable
// (fix the campaign, which contains the ad set, rather than the ad set alone).
const LEVEL_RANK = { campaign: 3, adset: 2, adgroup: 2, ad: 1 };

const DISPERSION_FAMILY = /^(CAMP-CPA|META-ADSET|TIKTOK-ADGROUP)/;
const GEO_FAMILY = /(GOOGLE|META)-GEO/;

const campaignNameOf = (finding) => {
  const ev = finding?.evidence || {};
  return ev.worstEntity || ev.worstCampaign || ev.campaign || null;
};

/**
 * Fold a GEO finding into the campaign-dispersion finding that owns the same
 * spend pool. In a single-region-per-campaign account a geo leak (e.g. Pakistan)
 * and the campaign running over baseline (e.g. "Display | PK …") are the SAME
 * dollars described twice — listing both double-states the recoverable figure in
 * the findings table, money map, and action plan. We keep the campaign finding
 * (more actionable), drop the standalone geo money line, and preserve the geo
 * INSIGHT by recording it as the campaign's root-cause driver (+ location fix).
 *
 * Conservative: only folds when the country token is actually present in the
 * campaign's name (strong proof they're the same pool). A geo finding that spans
 * multiple campaigns has no single owner and is left as its own line.
 */
const foldGeoIntoCampaign = (findings) => {
  // The surviving campaign-dispersion finding per platform (≤1 after the pass
  // above). Geo only ever overlaps the campaign-level pool.
  const campByPlatform = new Map();
  findings.forEach((f, index) => {
    if (!DISPERSION_FAMILY.test(f.ruleId || "")) return;
    if (levelOf(f) !== "campaign") return;
    const key = f.platform || "_";
    if (!campByPlatform.has(key)) campByPlatform.set(key, { finding: f, index });
  });
  if (campByPlatform.size === 0) return findings;

  const drop = new Set();
  const enrich = new Map(); // campaign index → geo finding folded into it

  findings.forEach((g) => {
    if (!GEO_FAMILY.test(g.ruleId || "")) return;
    const country = g.evidence?.country;
    for (const { finding: camp, index } of campByPlatform.values()) {
      if (camp.platform !== (g.platform || camp.platform)) continue;
      if (geoMatchesEntity(country, campaignNameOf(camp))) {
        drop.add(g); // drop by reference
        if (!enrich.has(index)) enrich.set(index, g);
        break;
      }
    }
  });
  if (drop.size === 0) return findings;

  return findings
    .map((f, index) => (enrich.has(index) ? mergeGeoCause(f, enrich.get(index)) : f))
    .filter((f) => !drop.has(f));
};

// Return a clone of the campaign finding enriched with the geo finding's causal
// insight, so the report shows ONE money line but still explains location as the
// driver and offers the location-targeting fix.
const mergeGeoCause = (camp, geo) => {
  const country = geo.evidence?.country || "the leaking market";
  // If the under-performing country is the campaign's OWN target market (its name
  // carries the country token), this is NOT a leak to exclude — it is the intended
  // market converting below baseline. Excluding it would kill the campaign; the
  // real fix is downstream (offer / landing page / funnel). Advising "exclude
  // Pakistan" on a campaign literally named "PK" is the kind of wrong call an
  // expert audit (which read this as a structural funnel issue) does not make.
  const intendedMarket = geoMatchesEntity(country, campaignNameOf(camp));
  // Intended-market case: the country is named in the campaign, so it CANNOT be a
  // market to exclude (that would kill the campaign). Two real causes remain —
  // (1) a "Presence or interest" setting leaking budget to users outside the
  // country, or (2) the market genuinely converting below baseline (a downstream
  // offer/landing-page/funnel issue, e.g. a structural access barrier). The
  // defensive call checks targeting precision first, then points downstream —
  // never "exclude {country}".
  const causeNote = intendedMarket
    ? ` The driver is geographic but tied to this campaign's own target market: ${country} is named in the campaign, so it is not a market to exclude. First confirm location targeting is "Presence" (not "Presence or interest"), which can leak budget to users outside ${country}; if targeting is already correct, the below-baseline cost is downstream — the offer, landing page, or funnel for ${country} — not a reason to cut the market.`
    : ` The primary driver is geographic: spend is leaking to ${country}, which converts well below the account baseline — so correcting location targeting (set targeting to physical "Presence", and exclude ${country} if it is outside your intended market) is the root-cause fix, not an across-the-board campaign cut.`;
  const geoFix = intendedMarket
    ? `Confirm location targeting is "Presence" not "Presence or interest"; if it already is, fix the ${country} funnel downstream (offer, landing page, conversion path) rather than excluding the campaign's own target market.`
    : (geo.fixSteps || []).find((s) => /presence|location|exclud|geo/i.test(s)) ||
      `Review location settings and exclude ${country} if it is outside your intended market.`;
  const existingFix = camp.fixSteps || [];
  // Only suppress the appended step when a TARGETING/PRESENCE step already exists.
  // (A generic "diagnose…landing page" dispersion step must not block the specific
  // Presence-vs-interest guidance.)
  const matcher = /presence|location targeting|exclud/i;
  const fixSteps = existingFix.some((s) => matcher.test(s))
    ? existingFix
    : [...existingFix, geoFix];

  return {
    ...camp,
    detail: `${camp.detail || ""}${causeNote}`,
    rootCause: camp.rootCause
      ? `${camp.rootCause} ${
          intendedMarket
            ? `${country} is the campaign's own target market — the gap is targeting precision (Presence vs interest) or a downstream funnel issue, not a market to exclude.`
            : `The dispersion is driven by a geographic leak to ${country}.`
        }`
      : intendedMarket
        ? `${country} is this campaign's own target market — the below-baseline cost is targeting precision (Presence vs interest) or downstream (funnel/landing page), not a market to exclude.`
        : `The per-campaign CPA gap is driven by a geographic leak to ${country}, which converts below baseline.`,
    evidence: {
      ...camp.evidence,
      geoCauseFolded: country,
      geoCauseFoldedFrom: geo.ruleId,
      geoIntendedMarket: intendedMarket,
    },
    fixSteps,
  };
};

const levelOf = (finding) => {
  const lvl = finding?.evidence?.level;
  if (lvl && LEVEL_RANK[lvl]) return lvl;
  // Infer from rule id when evidence.level is absent.
  if (/^CAMP-CPA/.test(finding.ruleId || "")) return "campaign";
  if (/^META-ADSET/.test(finding.ruleId || "")) return "adset";
  if (/^TIKTOK-ADGROUP/.test(finding.ruleId || "")) return "adgroup";
  return "campaign";
};

const SEVERITY_RANK = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1, INFO: 0 };
const CONFIDENCE_RANK = { high: 3, medium: 2, low: 1 };

const confidenceRank = (f) => CONFIDENCE_RANK[String(f?.evidence?.confidence || "").toLowerCase()] ?? 0;

// Which of two overlapping dispersion findings to KEEP: most actionable level,
// then highest confidence, then larger recoverable amount, then earlier.
const preferKeep = (a, b) => {
  const lvl = (LEVEL_RANK[levelOf(b.finding)] || 0) - (LEVEL_RANK[levelOf(a.finding)] || 0);
  if (lvl !== 0) return lvl < 0 ? a : b;
  const conf = confidenceRank(b.finding) - confidenceRank(a.finding);
  if (conf !== 0) return conf < 0 ? a : b;
  const amt = b.amount - a.amount;
  if (amt !== 0) return amt < 0 ? a : b;
  return a; // earlier
};

/**
 * @param {Array} findings
 * @returns {Array} findings with overlapping dispersion findings collapsed to
 *   one per platform, original order otherwise preserved.
 */
export const collapseOverlappingFindings = (findings = []) => {
  // Group dispersion-family findings by platform — they overlap by construction.
  const byPlatform = new Map();
  findings.forEach((f, index) => {
    if (!DISPERSION_FAMILY.test(f.ruleId || "")) return;
    const key = f.platform || "_";
    if (!byPlatform.has(key)) byPlatform.set(key, []);
    byPlatform.get(key).push({ finding: f, index, amount: parseImpactDollars(f.estimatedImpact) });
  });

  const drop = new Set();
  for (const group of byPlatform.values()) {
    if (group.length < 2) continue;
    const keep = group.reduce((winner, cur) => preferKeep(winner, cur));
    for (const g of group) if (g.index !== keep.index) drop.add(g.index);
  }

  // Pass 1 result: dispersion duplicates collapsed.
  const afterDispersion = drop.size === 0 ? findings : findings.filter((_, index) => !drop.has(index));

  // Pass 2: fold an overlapping geo finding into the campaign it belongs to.
  return foldGeoIntoCampaign(afterDispersion);
};
