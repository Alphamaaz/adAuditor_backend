/**
 * Composes the immediate-alert email from a small set of urgent items. Each item
 * is { title, impact, fix } — the same proof → fix shape as the report, so an
 * alert is always actionable, never just "something happened".
 *
 * Pure (no I/O) so it's unit-testable; the pipeline does the sending.
 */

const escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export const buildAuditAlertEmail = ({ accountName, items = [], reportUrl = null } = {}) => {
  const n = items.length;
  const subject = `⚠ ${n} new issue${n === 1 ? "" : "s"} need attention${accountName ? ` — ${accountName}` : ""}`;

  const itemHtml = items
    .map(
      (it) => `
      <tr><td style="padding:14px 0;border-bottom:1px solid #E6E8E3">
        <div style="font-weight:600;color:#16211B;font-size:15px">${escapeHtml(it.title)}</div>
        <div style="margin-top:4px;color:#B3261E;font-size:13px;font-weight:600">${escapeHtml(it.impact)}</div>
        <div style="margin-top:4px;color:#46524B;font-size:13px"><b>Fix:</b> ${escapeHtml(it.fix)}</div>
      </td></tr>`
    )
    .join("");

  const cta = reportUrl
    ? `<a href="${escapeHtml(reportUrl)}" style="display:inline-block;margin-top:20px;background:#0F3A2C;color:#fff;text-decoration:none;padding:11px 22px;border-radius:8px;font-weight:600;font-size:14px">View the full audit →</a>`
    : "";

  const html = `
    <div style="font-family:system-ui,sans-serif;max-width:560px;color:#16211B">
      <p style="font:600 11px 'IBM Plex Mono',monospace;letter-spacing:.14em;text-transform:uppercase;color:#B3261E;margin:0 0 6px">Account alert</p>
      <h2 style="font-size:20px;margin:0 0 8px">${n} new issue${n === 1 ? "" : "s"} need attention${accountName ? ` on ${escapeHtml(accountName)}` : ""}</h2>
      <p style="color:#46524B;font-size:14px;margin:0 0 8px">These appeared since your last audit and are time-sensitive — money is being lost or delivery is blocked right now.</p>
      <table style="width:100%;border-collapse:collapse;margin-top:8px">${itemHtml}</table>
      ${cta}
      <p style="color:#7C857F;font-size:12px;margin-top:24px">You're getting this because monitoring is on for this account. Known issues already in your last report are not repeated here.</p>
    </div>`;

  const text =
    `${n} new issue${n === 1 ? "" : "s"} need attention${accountName ? ` on ${accountName}` : ""}\n` +
    `(New since your last audit — known issues are not repeated.)\n\n` +
    items.map((it) => `• ${it.title}\n  Impact: ${it.impact}\n  Fix: ${it.fix}`).join("\n\n") +
    (reportUrl ? `\n\nView the full audit: ${reportUrl}` : "");

  return { subject, html, text };
};
