/**
 * PII redaction for AI prompts.
 *
 * Strips email addresses, phone numbers, and known sensitive field values
 * from any object before it is sent to a third-party LLM provider.
 *
 * Toggle via AI_PII_REDACTION env var:
 *   - "true" (recommended for production with EU customers)
 *   - "false" or unset (default — no redaction, faster + cheaper but
 *     compliance burden falls on signed DPA)
 *
 * Redaction is intentionally lossy: a redacted prompt cannot be reversed
 * by the LLM provider. Where possible we replace values with type-tagged
 * placeholders ("[EMAIL]", "[PHONE]") so the AI still understands shape.
 */

const ENABLED = () =>
  String(process.env.AI_PII_REDACTION || "").toLowerCase() === "true";

const EMAIL_RX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
// E.164-ish + common locale patterns. Conservative.
const PHONE_RX =
  /(?:\+?\d{1,3}[ -]?)?(?:\(?\d{2,4}\)?[ -]?)?\d{3,4}[ -]?\d{3,4}\b/g;

const SENSITIVE_KEY_HINTS = new Set([
  "email",
  "phone",
  "ownerName",
  "customerEmail",
  "customerPhone",
  "name", // business profile sometimes carries owner name
]);

const redactString = (value) => {
  if (typeof value !== "string") return value;
  let out = value.replace(EMAIL_RX, "[EMAIL]");
  out = out.replace(PHONE_RX, "[PHONE]");
  return out;
};

const redactValue = (value, keyHint) => {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map((v) => redactValue(v));
  if (typeof value === "object") return redactObject(value);
  if (typeof value === "string") {
    // Whole-field redaction when the key strongly suggests PII.
    if (keyHint && SENSITIVE_KEY_HINTS.has(keyHint)) {
      if (EMAIL_RX.test(value)) return "[EMAIL]";
      if (PHONE_RX.test(value)) return "[PHONE]";
      return "[REDACTED]";
    }
    return redactString(value);
  }
  return value;
};

const redactObject = (obj) => {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = redactValue(v, k);
  }
  return out;
};

/**
 * Returns a deep-cloned, redacted copy of `context` when redaction is on.
 * No-op (returns original reference) when disabled — zero overhead path.
 */
export const redactContext = (context) => {
  if (!ENABLED()) return context;
  if (context == null || typeof context !== "object") return context;
  return redactValue(context);
};

export const __test__ = { redactString, redactValue, EMAIL_RX, PHONE_RX };
