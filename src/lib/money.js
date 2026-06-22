/**
 * One shared money vocabulary for the whole engine.
 *
 * `formatMoney` emits "<CODE> <amount>" (e.g. "JPY 500,000", "CHF 1,200") for any
 * account currency, or "$<amount>" for USD. Several places parse that back out to
 * a number (overlap reconciliation, leverage ranking, the report money-map). Those
 * parsers used to keep their OWN currency allowlists, which drifted apart — a
 * Japanese (JPY) or Brazilian (BRL) account would parse to 0 in one place and a
 * real number in another, silently breaking the dedup. This module is the single
 * source of truth so they can never diverge again, and the list covers the global
 * markets a worldwide SaaS actually sees (Meta / Google / TikTok reporting
 * currencies), not just the ones we happened to test with.
 *
 * Pure + deterministic.
 */

// ISO-4217 codes for the currencies the ad platforms report in. Deliberately
// omits a few codes that are also common uppercase English words ("ALL" =
// Albanian lek, "TOP" = Tongan paʻanga) to avoid matching prose like "ALL 5
// campaigns" / "TOP 10" as money. Add codes here as new markets appear — this is
// the ONE place to change.
export const CURRENCY_CODES = [
  // Majors / reserve
  "USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD", "CNY", "HKD", "SGD",
  // Europe (non-euro)
  "SEK", "NOK", "DKK", "PLN", "CZK", "HUF", "RON", "BGN", "ISK", "UAH", "RUB",
  // Middle East / Africa
  "AED", "SAR", "QAR", "KWD", "BHD", "OMR", "JOD", "ILS", "TRY", "EGP", "ZAR",
  "NGN", "KES", "GHS", "MAD", "TND", "DZD",
  // South / Southeast / East Asia
  "INR", "PKR", "BDT", "LKR", "NPR", "IDR", "MYR", "THB", "PHP", "VND", "KRW",
  "TWD",
  // Americas
  "BRL", "MXN", "ARS", "CLP", "COP", "PEN", "UYU",
];

// Symbol + code alternation, longest-first not needed since codes are fixed-width.
const CURRENCY_ALT = `\\$|${CURRENCY_CODES.join("|")}`;

/**
 * Matches a money token: a currency symbol/code immediately followed by a number
 * (with optional thousands separators and decimals). Capture group 1 = the
 * numeric part. Construct fresh per call site if you need /g; this instance is
 * non-global for single .match() use.
 */
export const MONEY_RX = new RegExp(`(?:${CURRENCY_ALT})\\s?([\\d,]+(?:\\.\\d+)?)`);

/**
 * Parse the leading money magnitude from a string.
 * "PKR 4,280 in waste…" → 4280, "$1,200" → 1200, "¥ none here" → 0.
 */
export const parseMoney = (text) => {
  if (typeof text !== "string") {
    // Allow passing an object (e.g. evidence) — stringify so a nested formatted
    // value can still be found, mirroring the report's tolerant behaviour.
    if (text && typeof text === "object") text = JSON.stringify(text);
    else return 0;
  }
  const m = text.match(MONEY_RX);
  if (!m) return 0;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
};
