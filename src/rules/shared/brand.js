/**
 * Brand-term extraction + matching helpers.
 *
 * Brand terms live in `audit.businessProfileSnapshot.sectionA.brandTerms`
 * (array of strings) or `sectionA.brandName` (string fallback).
 *
 * All matching is:
 *   - case-insensitive
 *   - word-boundary aware (so "apple" does not match "pineapple")
 *   - tolerant of punctuation around words
 */

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const tokensFromInput = (input) => {
  if (Array.isArray(input)) {
    return input
      .map((v) => (typeof v === "string" ? v.trim() : ""))
      .filter((v) => v.length > 0);
  }
  if (typeof input === "string" && input.trim().length > 0) {
    // Allow "apple, swoosh, nike" by splitting on common separators.
    return input
      .split(/[,;|]/)
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
  }
  return [];
};

export const extractBrandTerms = (audit) => {
  const sectionA = audit?.businessProfileSnapshot?.sectionA || {};
  const terms = new Set();
  for (const token of tokensFromInput(sectionA.brandTerms)) terms.add(token.toLowerCase());
  for (const token of tokensFromInput(sectionA.brandName)) terms.add(token.toLowerCase());
  return [...terms];
};

/**
 * Build a single compiled regex that matches ANY of the brand terms with
 * word boundaries. Returns null when no terms.
 */
export const buildBrandRegex = (brandTerms) => {
  if (!brandTerms || brandTerms.length === 0) return null;
  const escaped = brandTerms.map(escapeRegex).join("|");
  return new RegExp(`\\b(?:${escaped})\\b`, "i");
};

/**
 * True if `value` contains any brand term (word-boundary, case-insensitive).
 * Pass a pre-built regex for hot loops; otherwise pass the terms array.
 */
export const matchesBrand = (value, brandRegexOrTerms) => {
  if (value == null) return false;
  const subject = String(value);
  let regex = brandRegexOrTerms;
  if (!regex) return false;
  if (Array.isArray(regex)) regex = buildBrandRegex(regex);
  if (!regex) return false;
  return regex.test(subject);
};
