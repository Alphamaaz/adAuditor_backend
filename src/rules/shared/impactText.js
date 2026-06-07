/**
 * Helpers for formatting estimatedImpact strings consistently.
 *
 * Rules SHOULD include a specific dollar figure whenever possible — this
 * is enforced socially by the architecture, but these helpers keep
 * formatting consistent so the AI narrative layer can rely on a stable
 * surface area.
 */

export const dollar = (amount) => {
  if (!Number.isFinite(amount)) return "$0";
  return "$" + Math.round(amount).toLocaleString("en-US");
};

export const percent = (fraction, digits = 1) => {
  if (!Number.isFinite(fraction)) return "0%";
  return (fraction * 100).toFixed(digits) + "%";
};

/**
 * Standard money-rule impact line:
 *   "$4,280 in monthly waste identified. Acting on this typically recovers
 *    80% ($3,424) within 2 weeks."
 */
export const moneyImpactLine = ({
  identifiedAmount,
  recoveryFactor = 0.8,
  recoveryWindow = "within 2 weeks",
}) => {
  const recovered = identifiedAmount * recoveryFactor;
  return (
    `${dollar(identifiedAmount)} in identified waste. ` +
    `Acting on this typically recovers ${percent(recoveryFactor, 0)} ` +
    `(${dollar(recovered)}) ${recoveryWindow}.`
  );
};
