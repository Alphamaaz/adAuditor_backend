import { reconcileRecoverable } from "../../lib/findings/recoverable.js";

/**
 * The weekly digest — the non-urgent rollup that complements the immediate
 * alerts. Where an alert says "your account is on fire right now", the digest
 * says "here's how your account moved this week and what changed". Pure: the
 * pipeline supplies the current + previous audit data and does the sending.
 */

const n = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const fmtMoney = (value, currency = "USD") =>
  `${String(currency || "USD").toUpperCase()} ${Math.round(n(value)).toLocaleString("en-US")}`;
const signed = (x) => (x > 0 ? `+${x}` : `${x}`);

const formatDate = (value) => {
  if (!value) return "your previous audit";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "your previous audit";
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(d);
};

const recoverableTotal = (findings, totals) =>
  reconcileRecoverable(
    (findings || []).filter((f) => f.evidence?.blocksDelivery !== true && f.evidence?.diagnostic !== true),
    { accountSpend: n(totals?.spend) }
  ).total;

/**
 * Compute the digest deltas between the latest audit and the prior one.
 * Returns null when there's no prior audit to compare against.
 *
 * @param {object} args
 * @param {object} args.current   { healthScore, completedAt, totals, findings }
 * @param {object} args.previous  same shape
 * @param {string} args.currency
 * @returns {{ metrics, resolved, added, persisting, since } | null}
 */
export const computeAuditDelta = ({ current, previous, currency = "USD" } = {}) => {
  if (!current || !previous) return null;
  const ct = current.totals || {};
  const pt = previous.totals || {};
  const metrics = [];

  if (typeof current.healthScore === "number" && typeof previous.healthScore === "number") {
    const d = current.healthScore - previous.healthScore;
    metrics.push({ label: "Health score", previous: String(previous.healthScore), current: String(current.healthScore), change: `${signed(d)} pts`, tone: d > 0 ? "good" : d < 0 ? "bad" : "neutral" });
  }

  const recPrev = recoverableTotal(previous.findings, pt);
  const recCur = recoverableTotal(current.findings, ct);
  if (recPrev > 0 || recCur > 0) {
    const d = recCur - recPrev;
    metrics.push({ label: "Recoverable identified", previous: fmtMoney(recPrev, currency), current: fmtMoney(recCur, currency), change: `${d < 0 ? "-" : "+"}${fmtMoney(Math.abs(d), currency)}`, tone: d < 0 ? "good" : d > 0 ? "bad" : "neutral" });
  }

  const cpaCur = n(ct.conversions) > 0 ? n(ct.spend) / n(ct.conversions) : null;
  const cpaPrev = n(pt.conversions) > 0 ? n(pt.spend) / n(pt.conversions) : null;
  if (cpaCur != null && cpaPrev != null) {
    const pct = cpaPrev > 0 ? Math.round((cpaCur / cpaPrev - 1) * 100) : null;
    metrics.push({ label: "Cost per acquisition", previous: fmtMoney(cpaPrev, currency), current: fmtMoney(cpaCur, currency), change: pct != null ? `${pct > 0 ? "+" : ""}${pct}%` : "—", tone: cpaCur < cpaPrev ? "good" : cpaCur > cpaPrev ? "bad" : "neutral" });
  }

  const ctrCur = n(ct.impressions) > 0 ? (n(ct.clicks) / n(ct.impressions)) * 100 : null;
  const ctrPrev = n(pt.impressions) > 0 ? (n(pt.clicks) / n(pt.impressions)) * 100 : null;
  if (ctrCur != null && ctrPrev != null) {
    const d = ctrCur - ctrPrev;
    metrics.push({ label: "Click-through rate", previous: `${ctrPrev.toFixed(2)}%`, current: `${ctrCur.toFixed(2)}%`, change: `${d >= 0 ? "+" : ""}${d.toFixed(2)}pp`, tone: d > 0 ? "good" : d < 0 ? "bad" : "neutral" });
  }

  if (pt.conversions != null) {
    const c = Math.round(n(ct.conversions));
    const p = Math.round(n(pt.conversions));
    const d = c - p;
    metrics.push({ label: "Conversions", previous: p.toLocaleString("en-US"), current: c.toLocaleString("en-US"), change: signed(d), tone: d > 0 ? "good" : d < 0 ? "bad" : "neutral" });
  }

  const curIds = new Set((current.findings || []).map((f) => f.ruleId));
  const prevIds = new Set((previous.findings || []).map((f) => f.ruleId));
  const resolved = (previous.findings || []).filter((f) => f.ruleId && !curIds.has(f.ruleId)).map((f) => f.title).filter(Boolean);
  const added = (current.findings || []).filter((f) => f.ruleId && !prevIds.has(f.ruleId)).map((f) => f.title).filter(Boolean);
  const persisting = (current.findings || []).filter((f) => f.ruleId && prevIds.has(f.ruleId)).length;

  return { metrics, resolved, added, persisting, since: previous.completedAt };
};

const escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const TONE_COLOR = { good: "#0E7A4F", bad: "#B3261E", neutral: "#7C857F" };
const arrow = (tone) => (tone === "good" ? "▲" : tone === "bad" ? "▼" : "→");

/**
 * Compose the weekly digest email from a computed delta.
 */
export const buildDigestEmail = ({ accountName, delta, reportUrl = null } = {}) => {
  const { metrics = [], resolved = [], added = [], persisting = 0, since } = delta || {};
  const sinceLabel = formatDate(since);
  const subject = `Your weekly account check${accountName ? ` — ${accountName}` : ""}`;

  const metricRows = metrics
    .map(
      (m) => `<tr>
        <td style="padding:8px 0;border-bottom:1px solid #E6E8E3;color:#16211B;font-size:13px">${escapeHtml(m.label)}</td>
        <td style="padding:8px 0;border-bottom:1px solid #E6E8E3;text-align:right;color:#7C857F;font-size:13px">${escapeHtml(String(m.previous))}</td>
        <td style="padding:8px 0;border-bottom:1px solid #E6E8E3;text-align:right;color:#16211B;font-size:13px;font-weight:600">${escapeHtml(String(m.current))}</td>
        <td style="padding:8px 0;border-bottom:1px solid #E6E8E3;text-align:right;font-size:13px;font-weight:600;color:${TONE_COLOR[m.tone] || TONE_COLOR.neutral}">${arrow(m.tone)} ${escapeHtml(String(m.change))}</td>
      </tr>`
    )
    .join("");

  const listBlock = (label, items, color) =>
    items.length
      ? `<p style="margin:14px 0 4px;font-size:13px;color:${color};font-weight:600">${label}</p><p style="margin:0;color:#46524B;font-size:13px">${items.slice(0, 6).map(escapeHtml).join("; ")}.</p>`
      : "";

  const cta = reportUrl
    ? `<a href="${escapeHtml(reportUrl)}" style="display:inline-block;margin-top:20px;background:#0F3A2C;color:#fff;text-decoration:none;padding:11px 22px;border-radius:8px;font-weight:600;font-size:14px">Open the full audit →</a>`
    : "";

  const html = `
    <div style="font-family:system-ui,sans-serif;max-width:600px;color:#16211B">
      <p style="font:600 11px 'IBM Plex Mono',monospace;letter-spacing:.14em;text-transform:uppercase;color:#1B5742;margin:0 0 6px">Weekly digest</p>
      <h2 style="font-size:20px;margin:0 0 8px">How ${accountName ? escapeHtml(accountName) : "your account"} moved</h2>
      <p style="color:#46524B;font-size:14px;margin:0 0 14px">Compared with your audit on ${escapeHtml(sinceLabel)}: <b>${resolved.length}</b> resolved, <b>${added.length}</b> new, <b>${persisting}</b> still open.</p>
      <table style="width:100%;border-collapse:collapse">
        <thead><tr>
          <th style="text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#7C857F;padding-bottom:6px">Metric</th>
          <th style="text-align:right;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#7C857F;padding-bottom:6px">Last</th>
          <th style="text-align:right;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#7C857F;padding-bottom:6px">Now</th>
          <th style="text-align:right;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#7C857F;padding-bottom:6px">Change</th>
        </tr></thead>
        <tbody>${metricRows}</tbody>
      </table>
      ${listBlock("Resolved since last audit", resolved, "#0E7A4F")}
      ${listBlock("New since last audit", added, "#B26A12")}
      ${cta}
      <p style="color:#7C857F;font-size:12px;margin-top:24px">Sent weekly while monitoring is on. Manage alerts in Settings → Alerts.</p>
    </div>`;

  const text =
    `How ${accountName || "your account"} moved\n` +
    `Compared with ${sinceLabel}: ${resolved.length} resolved, ${added.length} new, ${persisting} still open.\n\n` +
    metrics.map((m) => `${m.label}: ${m.previous} → ${m.current} (${m.change})`).join("\n") +
    (resolved.length ? `\n\nResolved: ${resolved.slice(0, 6).join("; ")}` : "") +
    (added.length ? `\nNew: ${added.slice(0, 6).join("; ")}` : "") +
    (reportUrl ? `\n\nOpen the full audit: ${reportUrl}` : "");

  return { subject, html, text };
};
