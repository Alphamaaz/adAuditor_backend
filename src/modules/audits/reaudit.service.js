/**
 * Which monitored accounts are due for an automatic re-audit. Pure +
 * deterministic so the scheduling decision is unit-testable without a DB.
 *
 * An account is due when monitoring is on AND it has never been auto-audited,
 * or its last auto-audit is older than the interval.
 *
 * @param {object} args
 * @param {Array} args.accounts   [{ monitoringEnabled, lastAutoAuditAt }]
 * @param {number} args.now       epoch ms
 * @param {number} args.intervalMs
 * @returns {Array} the subset that is due
 */
export const selectDueAccounts = ({ accounts = [], now = Date.now(), intervalMs = 0 } = {}) =>
  (accounts || []).filter((a) => {
    if (!a || a.monitoringEnabled !== true) return false;
    if (!a.lastAutoAuditAt) return true;
    const last = new Date(a.lastAutoAuditAt).getTime();
    if (!Number.isFinite(last)) return true;
    return now - last >= intervalMs;
  });
