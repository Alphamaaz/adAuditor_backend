/**
 * Comparable-cohort baselines.
 *
 * Judging every campaign against one blended account CPA is wrong whenever an
 * account runs more than one kind of conversion. A website lead, a Telegram /
 * WhatsApp conversation, an app install and a purchase have structurally
 * different costs — a messaging conversation legitimately costs a fraction of a
 * website lead. A single baseline therefore brands the cheaper-by-nature
 * destinations as "over baseline" (false positive) and lets the pricier ones look
 * fine (false negative). The Telegram campaign at a perfectly healthy cost gets
 * flagged as the "main efficiency drag" only because it was measured against the
 * wrong yardstick.
 *
 * The fix: group entities into cohorts by result family (the conversion type,
 * which is the best available proxy for "where the campaign sends people"), and
 * baseline EACH cohort against its own peers. A campaign is only ever judged
 * against campaigns that buy the same kind of result. A cohort with too few peers
 * (a singleton destination) has no honest baseline — we return null rather than
 * assert one, so the engine stays silent instead of confidently wrong.
 *
 * Degrades gracefully: data with no result-family signal (some CSV uploads) all
 * lands in one "unknown" cohort, reproducing the old single-baseline behaviour.
 *
 * Pure + deterministic.
 */

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// A cohort needs at least this many converting peers before its average is a
// trustworthy yardstick, and enough total conversions to be statistically stable.
export const COHORT_MIN_PEERS = 2;
export const COHORT_MIN_CONVERSIONS = 10;

/** The comparable-cohort key for an entity: its conversion type / destination. */
export const cohortKeyOf = (entity) =>
  String(entity?.resultFamily || "").toLowerCase().trim() || "unknown";

/** Human label for a family key, for finding prose. */
const FAMILY_LABELS = {
  lead: "lead",
  messaging: "messaging/conversation",
  purchase: "purchase",
  registration: "registration",
  app_install: "app-install",
  subscribe: "subscription",
  trial: "trial",
  landing_page_view: "landing-page-view",
  link_click: "traffic",
  unknown: "comparable",
};
export const cohortLabel = (key) => FAMILY_LABELS[key] || String(key || "comparable");

/**
 * Build per-cohort baselines from a list of entities (campaigns / ad sets).
 * Each entity needs `spend` and `conversions` (or `results`) and ideally
 * `resultFamily`.
 *
 * @returns {Map<string, { key, baselineCpa, count, spend, conversions, valid }>}
 *   `valid` is true only when the cohort has ≥COHORT_MIN_PEERS converting members
 *   and ≥COHORT_MIN_CONVERSIONS conversions — i.e. an honest yardstick exists.
 */
export const buildCohortBaselines = (entities = []) => {
  const groups = new Map();
  for (const e of entities) {
    const spend = num(e.spend);
    const conversions = num(e.conversions ?? e.results);
    if (spend <= 0) continue;
    const key = cohortKeyOf(e);
    const g = groups.get(key) || { key, spend: 0, conversions: 0, count: 0 };
    g.spend += spend;
    // Only converting members inform the baseline (a zero-conversion campaign has
    // no CPA and would just deflate the cohort's apparent peer count).
    if (conversions > 0) {
      g.conversions += conversions;
      g.count += 1;
    }
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    g.valid =
      g.count >= COHORT_MIN_PEERS &&
      g.conversions >= COHORT_MIN_CONVERSIONS &&
      g.spend > 0;
    g.baselineCpa = g.conversions > 0 ? g.spend / g.conversions : null;
  }
  return groups;
};

/**
 * The baseline an entity should be judged against: its own cohort's baseline when
 * that cohort has enough comparable peers, otherwise null (not confidently
 * comparable — the caller must not assert an "over baseline" verdict).
 */
export const cohortBaselineFor = (entity, cohorts) => {
  const g = cohorts.get(cohortKeyOf(entity));
  return g && g.valid && g.baselineCpa > 0 ? g.baselineCpa : null;
};
