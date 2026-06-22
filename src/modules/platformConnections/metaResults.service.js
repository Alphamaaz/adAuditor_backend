/**
 * Objective-aware result resolution for Meta insights.
 *
 * Meta's `actions` array carries many action types per row. The "result" of a
 * campaign is the action that matches its optimisation objective — not whatever
 * a fixed cross-objective priority happens to rank first.
 *
 * The old approach (a single global priority list, first match wins) had a fatal
 * failure mode on this account: a messaging campaign reports BOTH
 * `messaging_conversation_started_7d` (a click-attributed subset) AND
 * `total_messaging_connection` (the full count). Ranking the subset above the
 * total made the engine count 37 conversations where Meta reports 183 — a 5×
 * under-count that then poisoned every baseline-derived "waste" figure.
 *
 * The fix has two parts:
 *   1. Choose the candidate result FAMILY from the entity's objective /
 *      optimisation goal (messaging vs leads vs purchases vs installs …).
 *   2. Within a family, aggregate correctly:
 *        - members that are OVERLAPPING views of one outcome (the messaging
 *          metrics, the several purchase variants) → take the MAX, never the
 *          first or the sum.
 *        - distinct families are tried in objective order; the first family that
 *          actually has volume wins.
 *
 * Pure + deterministic → unit-testable without the Graph API.
 */

const num = (value) => {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (value == null) return 0;
  const n = Number(String(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

/**
 * Result families. Each family is a set of Meta action types that describe the
 * SAME business outcome. Members are matched by exact type or suffix (so
 * "purchase" also catches `omni_purchase` and
 * `offsite_conversion.fb_pixel_purchase`). Because members overlap, the family's
 * value is the MAX present — this is what de-duplicates the messaging metrics
 * and the purchase variants into one honest count.
 */
const RESULT_FAMILIES = {
  purchase: ["purchase", "omni_purchase", "offsite_conversion.fb_pixel_purchase"],
  lead: ["lead", "leadgen_grouped", "onsite_conversion.lead_grouped", "offsite_conversion.fb_pixel_lead"],
  registration: ["complete_registration", "offsite_conversion.fb_pixel_complete_registration"],
  subscribe: ["subscribe"],
  trial: ["start_trial"],
  messaging: [
    "onsite_conversion.messaging_conversation_started_7d",
    "messaging_conversation_started_7d",
    "onsite_conversion.total_messaging_connection",
    "total_messaging_connection",
    "onsite_conversion.messaging_first_reply",
  ],
  app_install: ["mobile_app_install", "omni_app_install", "app_install"],
  landing_page_view: ["landing_page_view", "omni_landing_page_view"],
  link_click: ["link_click"],
  // Mid-funnel — only ever a last resort when no real conversion exists, so an
  // account that tracks nothing past add-to-cart still yields a signal rather
  // than null. Never ranked above a true result.
  checkout: [
    "initiate_checkout",
    "initiated_checkout",
    "omni_initiated_checkout",
    "add_to_cart",
    "omni_add_to_cart",
  ],
};

/**
 * Objective → ordered list of candidate result families. Covers both the modern
 * ODAX objectives (`OUTCOME_*`) and legacy objective names. The first family
 * with real volume on the entity is its result.
 */
const OBJECTIVE_FAMILIES = {
  OUTCOME_SALES: ["purchase", "lead", "registration", "checkout"],
  OUTCOME_LEADS: ["lead", "messaging", "registration", "purchase"],
  OUTCOME_ENGAGEMENT: ["messaging", "lead", "landing_page_view", "link_click"],
  OUTCOME_TRAFFIC: ["landing_page_view", "link_click"],
  OUTCOME_APP_PROMOTION: ["app_install"],
  OUTCOME_AWARENESS: [],
  // Legacy objectives
  CONVERSIONS: ["purchase", "lead", "registration", "checkout"],
  PRODUCT_CATALOG_SALES: ["purchase", "checkout"],
  LEAD_GENERATION: ["lead", "messaging"],
  MESSAGES: ["messaging"],
  LINK_CLICKS: ["link_click", "landing_page_view"],
  APP_INSTALLS: ["app_install"],
  POST_ENGAGEMENT: ["messaging", "link_click"],
  PAGE_LIKES: [],
  REACH: [],
  BRAND_AWARENESS: [],
  VIDEO_VIEWS: [],
};

/**
 * Optimisation goal (set at the ad-set level) → result families. More precise
 * than the campaign objective when available — e.g. an OUTCOME_LEADS campaign
 * whose ad set optimises for CONVERSATIONS is really a messaging result.
 */
const OPT_GOAL_FAMILIES = {
  CONVERSATIONS: ["messaging"],
  LEAD_GENERATION: ["lead", "messaging"],
  QUALITY_LEAD: ["lead"],
  QUALITY_CALL: ["lead"],
  OFFSITE_CONVERSIONS: ["purchase", "lead", "registration"],
  VALUE: ["purchase"],
  LANDING_PAGE_VIEWS: ["landing_page_view"],
  LINK_CLICKS: ["link_click", "landing_page_view"],
  APP_INSTALLS: ["app_install"],
  POST_ENGAGEMENT: ["messaging", "link_click"],
  REACH: [],
  IMPRESSIONS: [],
  AD_RECALL_LIFT: [],
  THRUPLAY: [],
  TWO_SECOND_CONTINUOUS_VIDEO_VIEWS: [],
};

// When objective is unknown, try families in this order. Messaging sits below
// hard conversions but above traffic, so a genuine purchase/lead still wins.
const DEFAULT_FAMILY_ORDER = [
  "purchase",
  "lead",
  "registration",
  "subscribe",
  "trial",
  "messaging",
  "app_install",
  "landing_page_view",
  "link_click",
  "checkout",
];

const matchAction = (actions, type) => {
  if (!Array.isArray(actions)) return null;
  const match = actions.find(
    (a) => a.action_type === type || a.action_type?.endsWith(type)
  );
  return match ? num(match.value) : null;
};

/**
 * The value of one family on an actions array: the MAX across its overlapping
 * member types. Returns null when none are present.
 */
const familyValue = (actions, familyKey) => {
  const types = RESULT_FAMILIES[familyKey] || [];
  let best = null;
  for (const type of types) {
    const v = matchAction(actions, type);
    if (v != null && (best == null || v > best)) best = v;
  }
  return best;
};

/**
 * Resolve the ordered candidate families for an entity from whatever objective
 * signal is available. `optimizationGoal` (ad-set level) wins over `objective`
 * (campaign level); an unknown signal falls back to a sensible global order.
 */
export const resolveResultFamilies = ({ objective, optimizationGoal } = {}) => {
  const goal = String(optimizationGoal || "").toUpperCase();
  if (goal && OPT_GOAL_FAMILIES[goal]) return OPT_GOAL_FAMILIES[goal];

  const obj = String(objective || "").toUpperCase();
  if (obj && OBJECTIVE_FAMILIES[obj]) return OBJECTIVE_FAMILIES[obj];

  // Partial / fuzzy match for objective strings outside the table.
  if (/MESSAG/.test(obj) || /CONVERSATION/.test(goal)) return ["messaging", "lead"];
  if (/LEAD/.test(obj)) return ["lead", "messaging", "registration"];
  if (/SALE|PURCHASE|CONVERSION|CATALOG|VALUE/.test(obj)) return ["purchase", "lead", "registration"];
  if (/APP/.test(obj)) return ["app_install"];
  if (/TRAFFIC|LINK|CLICK/.test(obj)) return ["landing_page_view", "link_click"];
  if (/ENGAGE/.test(obj)) return ["messaging", "link_click"];
  if (/AWARENESS|REACH|VIDEO|LIKE/.test(obj)) return [];

  return DEFAULT_FAMILY_ORDER;
};

/**
 * Resolve the result count for one insight row.
 *
 * @returns {{ results: number|null, resultFamily: string|null }}
 *   `results` is null when the objective is non-result (awareness/reach) or the
 *   actions array carries none of the candidate families.
 */
export const resolveResult = (actions, context = {}) => {
  const families = resolveResultFamilies(context);
  for (const fam of families) {
    const value = familyValue(actions, fam);
    if (value != null && value > 0) return { results: value, resultFamily: fam };
  }
  return { results: null, resultFamily: null };
};

/**
 * Determine the account's dominant result families from its campaign insight
 * rows (the objective carrying the most spend). Used to resolve results for
 * breakdown rows and ads, which don't carry their own objective.
 */
export const resolveAccountFamilies = (campaignInsights = []) => {
  const spendByObjective = new Map();
  for (const row of campaignInsights || []) {
    const obj = String(row.objective || "").toUpperCase();
    if (!obj) continue;
    spendByObjective.set(obj, (spendByObjective.get(obj) || 0) + num(row.spend));
  }
  let dominant = null;
  let max = -1;
  for (const [obj, spend] of spendByObjective.entries()) {
    if (spend > max) {
      max = spend;
      dominant = obj;
    }
  }
  return resolveResultFamilies({ objective: dominant });
};

/**
 * Result count for a row given a pre-resolved family list (used for breakdowns
 * and ads where the family is decided at the account level).
 */
export const resultForFamilies = (actions, families = DEFAULT_FAMILY_ORDER) => {
  for (const fam of families) {
    const value = familyValue(actions, fam);
    if (value != null && value > 0) return value;
  }
  return null;
};

export const __test__ = { familyValue, RESULT_FAMILIES, OBJECTIVE_FAMILIES };
