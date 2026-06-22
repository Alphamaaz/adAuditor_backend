/**
 * Decides which people receive an account's alert — the agency-routing layer.
 *
 *   - If the ad account is ASSIGNED to a team member, only that assignee (plus
 *     the person who ran the audit) is notified. This is how an agency routes
 *     Client X's alerts to the manager who owns Client X, without spamming the
 *     whole team for every account.
 *   - If the account is unassigned, the org OWNERs (plus the audit runner) get
 *     it — the safe default.
 *   - Anyone who muted alerts (alertsEnabled === false) is filtered out.
 *
 * Recipients are AdAdviser platform users (the people logged into AdAdviser),
 * never the connected ad account's owner — we don't have, and shouldn't email,
 * the OAuth-connected account's address.
 *
 * Pure + deterministic; the pipeline does the DB query and passes `members` in.
 *
 * @param {object} args
 * @param {string|null} args.assigneeUserId  AdAccount.assignedUserId, if any
 * @param {string|null} args.createdById      the audit's creator userId
 * @param {Array} args.members  [{ userId, role, alertsEnabled, email }] for the org
 * @returns {string[]} unique recipient emails
 */
export const selectAlertRecipients = ({ assigneeUserId = null, createdById = null, members = [] }) => {
  const active = (members || []).filter((m) => m && m.alertsEnabled !== false && m.email);
  const emailById = new Map(active.map((m) => [m.userId, m.email]));
  const out = new Set();
  const add = (userId) => {
    if (userId && emailById.has(userId)) out.add(emailById.get(userId));
  };

  if (assigneeUserId) {
    // Assigned account → only the assignee + whoever ran the audit.
    add(assigneeUserId);
    add(createdById);
  } else {
    // Unassigned → the audit runner + the org owners.
    add(createdById);
    for (const m of active) {
      if (m.role === "OWNER") out.add(m.email);
    }
  }
  return [...out];
};
