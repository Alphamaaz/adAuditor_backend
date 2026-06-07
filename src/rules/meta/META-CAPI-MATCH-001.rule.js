/**
 * META-CAPI-MATCH-001
 *
 * Surfaces CAPI deployment and match-rate gaps. CAPI (Meta Conversions API)
 * is server-side event delivery. Without it — or with a low pixel-CAPI match
 * rate — Meta attribution under-counts conversions, which cascades into
 * every CPA, ROAS, and optimization decision.
 *
 * Detection (self-reported, gated on intake answers):
 *   M_CAPI_STATUS:
 *     "not_deployed" → HIGH
 *     "unsure"       → MEDIUM
 *     "deployed"     → check match rate
 *   M_CAPI_MATCH_RATE (0-100):
 *     < HIGH_SEVERITY_MAX_MATCH_RATE (70)        → HIGH
 *     [70, MEDIUM_SEVERITY_MAX_MATCH_RATE 85)    → MEDIUM
 *     >= 85                                       → no fire
 *
 * Returns null when no answer is provided — absent data must not produce
 * a finding.
 *
 * Cost: cheap (intake-lookup only).
 */

import {
  getPlatformAnswers,
  getPlatformRecords,
} from "../shared/context-helpers.js";
import { numberValue } from "../shared/numeric.js";
import { META_CAPI_MATCH as T } from "../shared/thresholds/meta.js";

const normalizeStatus = (value) => {
  const v = String(value || "").toLowerCase().trim();
  if (!v) return null;
  if (v.includes("not") && v.includes("deploy")) return T.STATUS_NOT_DEPLOYED;
  if (v === "no" || v === "false") return T.STATUS_NOT_DEPLOYED;
  if (v.includes("unsure") || v.includes("don't know") || v.includes("dont know"))
    return T.STATUS_UNSURE;
  if (v === T.STATUS_DEPLOYED || v === "yes" || v === "true")
    return T.STATUS_DEPLOYED;
  return v; // best-effort passthrough
};

export default {
  id: "META-CAPI-MATCH-001",
  version: "1.0.0",
  platforms: ["META"],
  category: "Tracking & Pixel Health",
  severity: "HIGH",
  minPlanTier: "free",
  estimatedImpactRange: { min: 0, max: 0 },
  confidence: "medium",
  requiresHistory: false,
  requiresBenchmarkData: false,
  costToEvaluate: "cheap",
  tags: ["money-rule", "meta", "tracking"],
  contextVersion: "v1",

  eval(ctx) {
    // Don't surface tracking issues when there's no Meta data to back them.
    const records = getPlatformRecords(ctx.dataset, "META");
    if (records.length === 0) return null;

    const answers = getPlatformAnswers(ctx.audit, "META");
    const rawStatus = answers[T.STATUS_KEY];
    const rawMatchRate = answers[T.MATCH_RATE_KEY];

    // Absent data → no finding.
    if (rawStatus == null && rawMatchRate == null) return null;

    const status = normalizeStatus(rawStatus);
    const matchRate =
      rawMatchRate == null || rawMatchRate === ""
        ? null
        : numberValue(rawMatchRate);

    let severity = null;
    let reason = null;
    let detail = "";
    let fixSteps = [];

    if (status === T.STATUS_NOT_DEPLOYED) {
      severity = "HIGH";
      reason = "not_deployed";
      detail =
        "Meta Conversions API (CAPI) is not deployed. Without server-side " +
        "event delivery, Meta attribution under-counts conversions caused by " +
        "iOS ATT, ad blockers, and third-party cookie loss. Every CPA and ROAS " +
        "in this audit is therefore understated.";
      fixSteps = [
        "Deploy CAPI via Meta Business Extension, Shopify CAPI, or a server-side GTM container.",
        "Send all standard events (Purchase, AddToCart, Lead, InitiateCheckout) via CAPI in parallel with the browser pixel.",
        "Include event_id deduplication so pixel + CAPI events do not double-count.",
        "Validate match rate in Events Manager → Diagnostics within 48 hours of deployment.",
      ];
    } else if (status === T.STATUS_UNSURE) {
      severity = "MEDIUM";
      reason = "status_unknown";
      detail =
        "CAPI deployment status is reported as unsure. Until this is confirmed, " +
        "the trustworthiness of Meta-attributed CPA and ROAS in this audit cannot " +
        "be verified.";
      fixSteps = [
        "Open Events Manager → your dataset → Overview to confirm whether CAPI events are flowing.",
        "If no CAPI events are listed, follow the deployment path above.",
        "If CAPI events are listed, check the EMQ (event match quality) score per event.",
      ];
    } else if (
      status === T.STATUS_DEPLOYED ||
      (status == null && matchRate != null)
    ) {
      if (matchRate == null) return null; // deployed but no match rate provided — can't grade
      if (matchRate < T.HIGH_SEVERITY_MAX_MATCH_RATE) {
        severity = "HIGH";
        reason = "low_match_rate";
        detail =
          `Reported CAPI match rate is ${matchRate}%. Below ${T.HIGH_SEVERITY_MAX_MATCH_RATE}% ` +
          `Meta cannot reliably associate server events with user identities, so reported ` +
          `conversions remain materially under-counted despite CAPI being live.`;
        fixSteps = [
          "Include hashed customer_email, customer_phone, and external_id in every CAPI event.",
          "Forward fbp/fbc cookies from the browser to the server-side endpoint on every event.",
          "Verify event_time is within Meta's 7-day window and sent in UTC seconds.",
          "Re-check EMQ in Events Manager 48 hours after deploying improvements.",
        ];
      } else if (matchRate < T.MEDIUM_SEVERITY_MAX_MATCH_RATE) {
        severity = "MEDIUM";
        reason = "moderate_match_rate";
        detail =
          `Reported CAPI match rate is ${matchRate}%. This is in the acceptable but ` +
          `improvable band (${T.HIGH_SEVERITY_MAX_MATCH_RATE}-${T.MEDIUM_SEVERITY_MAX_MATCH_RATE}%). ` +
          `Raising it above ${T.MEDIUM_SEVERITY_MAX_MATCH_RATE}% typically recovers ` +
          `5-10% of attributed conversions.`;
        fixSteps = [
          "Audit which CAPI events are missing customer identifiers — add hashed email/phone/external_id where absent.",
          "Confirm fbp/fbc are present on >95% of events.",
          "Re-check EMQ in 48 hours.",
        ];
      } else {
        return null; // match rate is healthy
      }
    } else {
      return null; // unrecognized status with no match rate
    }

    return {
      ruleId: "META-CAPI-MATCH-001",
      platform: "META",
      severity,
      category: "Tracking & Pixel Health",
      title:
        reason === "not_deployed"
          ? "Meta CAPI is not deployed — attribution is under-counted"
          : reason === "low_match_rate"
            ? `Meta CAPI match rate is ${matchRate}% — below the ${T.HIGH_SEVERITY_MAX_MATCH_RATE}% trust floor`
            : reason === "moderate_match_rate"
              ? `Meta CAPI match rate is ${matchRate}% — improvable`
              : "Meta CAPI deployment status is unknown",
      detail,
      evidence: {
        capiStatus: status,
        matchRate,
        reason,
        thresholds: {
          highSeverityMaxMatchRate: T.HIGH_SEVERITY_MAX_MATCH_RATE,
          mediumSeverityMaxMatchRate: T.MEDIUM_SEVERITY_MAX_MATCH_RATE,
        },
        estimatedLiftRangePercent:
          reason === "not_deployed"
            ? { min: 10, max: 20 }
            : reason === "low_match_rate"
              ? { min: 5, max: 15 }
              : reason === "moderate_match_rate"
                ? { min: 3, max: 8 }
                : null,
      },
      estimatedImpact:
        reason === "not_deployed"
          ? "Deploying CAPI typically recovers 10-20% of attributed conversions, which proportionally improves reported CPA and ROAS across the entire Meta account."
          : reason === "low_match_rate"
            ? "Raising CAPI match rate above 70% typically recovers 5-15% of attributed conversions."
            : reason === "moderate_match_rate"
              ? "Raising match rate above 85% typically recovers an additional 3-8% of attributed conversions."
              : "Trustworthiness of all Meta CPA/ROAS data depends on resolving CAPI status.",
      fixSteps,
    };
  },
};
