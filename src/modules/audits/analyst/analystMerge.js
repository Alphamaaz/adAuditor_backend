/**
 * AI Analyst — report-document merge. (spec: docs/AI_ANALYST_SPEC.md §6)
 *
 * Converts the VERIFIED analyst report into the shapes the existing report
 * document already renders: finding-like objects, extra sections, and
 * executive-summary paragraphs. Pure — no DB, no LLM.
 *
 * Money conservation (defensive by default):
 *   - An analyst finding's `netRecoverable` is ONLY the sum of the nets of the
 *     rule findings merged into it — money moves between findings, it is never
 *     created. The headline total can only stay equal or shrink (refuted).
 *   - Analyst-new findings with verified recoverable figures are advisory:
 *     the figure shows on the card, but does NOT enter the headline/money-map
 *     until it has been through a real overlap partition (future work). This
 *     is the report-21 lesson applied structurally.
 *   - A "merged" disposition without a resolvable target finding keeps the
 *     rule finding visible (treated as confirmed) so its money is never lost.
 */

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const formatMoney = (value, currency = "USD") => {
  const rounded = Math.round(num(value));
  const formatted = rounded.toLocaleString("en-US");
  return currency && currency !== "USD" ? `${currency} ${formatted}` : `$${formatted}`;
};

/** "Wasted spend on Display placements" → "wastedSpendOnDisplayPlacements" */
const labelToKey = (label) => {
  const words = String(label || "")
    .replace(/[^a-zA-Z0-9%\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5);
  if (words.length === 0) return null;
  return words
    .map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()))
    .join("");
};

const analystRuleId = (finding) => {
  const id = String(finding?.id || "").trim().toUpperCase().replace(/\s+/g, "-");
  if (!id) return "AN-FINDING";
  return id.startsWith("AN-") ? id : `AN-${id}`;
};

/**
 * Merge the verified analyst report into the deterministic findings list.
 *
 * @param {object} args
 * @param {object} args.analystReport  VERIFIED analyst report (post-verification)
 * @param {Array}  args.findings       rule findings (trust-layer nets present)
 * @param {string} args.currency
 * @param {string} [args.platform]
 * @returns {{ findings, hiddenRuleIds, refutedRuleIds, transferredNet }}
 */
export const applyAnalystMerge = ({ analystReport, findings, currency, platform }) => {
  const ruleById = new Map((findings || []).map((f) => [f.ruleId, f]));
  const analystById = new Map(
    (analystReport?.findings || []).map((f) => [analystRuleId(f), f])
  );

  // Resolve dispositions: which rule findings are hidden, and where their
  // money goes. A merge target must be a real analyst finding or the rule
  // finding stays visible (money conservation).
  const hiddenRuleIds = [];
  const refutedRuleIds = [];
  const mergedNetByAnalystId = new Map();

  for (const d of analystReport?.ruleFindingDispositions || []) {
    const rule = ruleById.get(d?.ruleId);
    if (!rule) continue;
    if (d.disposition === "refuted" && String(d.note || "").trim()) {
      refutedRuleIds.push(d.ruleId);
      hiddenRuleIds.push(d.ruleId);
      continue;
    }
    if (d.disposition === "merged") {
      const targetId = d.mergedIntoFindingId
        ? String(d.mergedIntoFindingId).trim().toUpperCase().replace(/\s+/g, "-")
        : null;
      const resolved =
        (targetId && (analystById.get(targetId) || analystById.get(`AN-${targetId}`))) || null;
      if (!resolved) continue; // no resolvable target → rule finding stays
      hiddenRuleIds.push(d.ruleId);
      const key = analystRuleId(resolved);
      const transferable =
        rule.evidence?.advisory === true || rule.evidence?.diagnostic === true
          ? 0
          : num(rule.evidence?.netRecoverable);
      mergedNetByAnalystId.set(key, (mergedNetByAnalystId.get(key) || 0) + Math.max(0, transferable));
    }
  }

  const hidden = new Set(hiddenRuleIds);
  const keptRuleFindings = (findings || []).filter((f) => !hidden.has(f.ruleId));

  // Convert analyst findings to the rule-finding shape the document renders.
  const converted = (analystReport?.findings || []).map((f) => {
    const id = analystRuleId(f);
    const inheritedNet = Math.round(mergedNetByAnalystId.get(id) || 0);
    const verifiedRecoverable = num(f.verifiedRecoverable);
    const advisory = inheritedNet <= 0;

    // Evidence: scalar entries render as the card's evidence table. Up to three
    // verified figures become scalar rows; the raw figure objects ride along
    // under an object key (skipped by the renderer, kept for traceability).
    const evidence = {
      source: "analyst",
      confidence: f.confidence,
      advisory,
      netRecoverable: inheritedNet,
      analystFigures: f.figures || [],
    };
    if (Array.isArray(f.campaignRefs) && f.campaignRefs[0]) {
      evidence.campaign = f.campaignRefs[0];
    }
    for (const fig of (f.figures || []).filter((x) => x.verified).slice(0, 3)) {
      const key = labelToKey(fig.label);
      if (key && evidence[key] === undefined) evidence[key] = fig.value;
    }

    const estimatedImpact =
      inheritedNet > 0
        ? `${formatMoney(inheritedNet, currency)} recoverable — ${f.title}`
        : verifiedRecoverable > 0
          ? `Measured inefficiency of ${formatMoney(verifiedRecoverable, currency)} (shown for context; not added to the headline total pending overlap review).`
          : null;

    return {
      ruleId: id,
      platform: platform || null,
      severity: f.severity,
      category: f.category || "analysis",
      title: f.title,
      detail: f.claim,
      evidence,
      estimatedImpact,
      fixSteps: [f.recommendation].filter(Boolean),
    };
  });

  return {
    findings: [...keptRuleFindings, ...converted],
    hiddenRuleIds,
    refutedRuleIds,
    transferredNet: [...mergedNetByAnalystId.values()].reduce((s, v) => s + v, 0),
  };
};

const VERDICT_TONE = {
  scale: "good",
  keep: "good",
  fix: "warn",
  pause: "warn",
  "verify-tracking": "warn",
};

const VERDICT_LABEL = {
  scale: "Scale",
  keep: "Keep",
  fix: "Fix",
  pause: "Pause",
  "verify-tracking": "Verify tracking",
};

/** Extra sections the analyst contributes to the document. */
export const analystSectionsFor = (analystReport, currency) => {
  const sections = [];

  const dives = (analystReport?.campaignDeepDives || []).filter(
    (d) => d?.campaignName && d?.diagnosis
  );
  if (dives.length > 0) {
    sections.push({
      id: "analyst-campaign-notes",
      eyebrow: "Strategist notes",
      title: "Campaign-by-campaign: what the numbers say",
      intro:
        "Written from the full raw dataset. Every cited figure has been machine-verified against the account data.",
      blocks: dives.slice(0, 12).map((d) => ({
        type: "callout",
        tone: VERDICT_TONE[d.verdict] || "info",
        text: `**${d.campaignName}** — ${VERDICT_LABEL[d.verdict] || d.verdict}: ${d.diagnosis}${
          Array.isArray(d.actions) && d.actions.length
            ? ` Next: ${d.actions.slice(0, 3).join(" · ")}`
            : ""
        }`,
      })),
    });
  }

  const recs = [...(analystReport?.recommendations || [])]
    .filter((r) => r?.action)
    .sort((a, b) => num(a.priority) - num(b.priority));
  if (recs.length > 0) {
    sections.push({
      id: "analyst-priority-moves",
      eyebrow: "Strategist notes",
      title: "Priority moves, in order",
      intro: "The strategist's ranked sequence — most leverage first.",
      blocks: [
        {
          type: "data_table",
          columns: [
            { header: "#", align: "left", width: "44px" },
            { header: "Move", align: "left" },
            { header: "Expected impact", align: "left", width: "220px" },
          ],
          currency,
          rows: recs.slice(0, 8).map((r, i) => [String(i + 1), r.action, r.expectedImpact || "—"]),
        },
      ],
    });
  }

  return sections;
};

/** Executive-summary paragraphs contributed by the analyst. */
export const analystExecutiveParagraphs = (analystReport) => {
  const paragraphs = [];
  if (analystReport?.executiveSummary) {
    paragraphs.push(`**Account story:** ${analystReport.executiveSummary}`);
  }
  if (analystReport?.rootCause) {
    paragraphs.push(`**Root cause:** ${analystReport.rootCause}`);
  }
  return paragraphs;
};
