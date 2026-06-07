/**
 * Comparison findings — peer + self-over-time findings emitted from audit
 * snapshots. Pure + deterministic so it unit-tests without a database.
 *
 * Consumed by the pipeline (processRunAudit) which supplies the current
 * snapshot + prior memory summaries. Emitting here keeps the comparison logic
 * out of the legacy engine (which has no access to prior audits).
 */

import {
  deriveKpis,
  normalizeSnapshotFromMemory,
  pickPeer,
  peerComparison,
  memoryDelta,
} from "../../lib/comparison/auditComparison.js";

const CTR_CATEGORY = {
  META: "Creative Performance",
  GOOGLE: "Quality Score & Relevance",
  TIKTOK: "Creative Performance",
};

const PLATFORM_LABELS = { META: "Meta", GOOGLE: "Google", TIKTOK: "TikTok" };

// Thresholds (centralized).
const T = {
  cpaRegressionPct: 20, // CPA worsened by ≥20% → regression
  cpaRegressionHighPct: 50,
  minConversionsForCpa: 10,
  healthImprovementPoints: 5,
  peerCtrWorsePct: 30, // current CTR ≥30% below peer → flag
};

/**
 * Build a snapshot of the current (live) audit for comparison.
 */
export const buildCurrentSnapshot = ({ audit, scores, dataset }) => {
  const totals = dataset?.summary?.totals || {};
  const spend = Number(totals.spend) || 0;
  const impressions = Number(totals.impressions) || 0;
  const clicks = Number(totals.clicks) || 0;
  const conversions = Number(totals.conversions) || 0;
  const bp = audit.businessProfileSnapshot?.sectionA || {};

  return {
    auditId: audit.id,
    adAccountId: audit.adAccountId || null,
    adAccountName: audit.adAccount?.name || null,
    completedAt: audit.completedAt || new Date().toISOString(),
    platforms: audit.selectedPlatforms || [],
    primaryPlatform: (audit.selectedPlatforms || [])[0] || null,
    businessType: bp.businessType || null,
    spend,
    impressions,
    clicks,
    conversions,
    kpis: deriveKpis({ spend, impressions, clicks, conversions }),
    healthScore: scores?.overall ?? audit.healthScore ?? null,
    criticalRuleIds: (audit.ruleFindings || [])
      .filter((f) => f.severity === "CRITICAL")
      .map((f) => f.ruleId),
  };
};

const finding = (f) => ({
  ruleId: f.ruleId,
  platform: f.platform,
  severity: f.severity,
  category: f.category,
  title: f.title,
  detail: f.detail,
  evidence: f.evidence,
  estimatedImpact: f.estimatedImpact,
  fixSteps: f.fixSteps,
});

/**
 * Produce comparison findings (0..n). Safe with empty priors → returns [].
 *
 * @param {object} args
 * @param {object} args.current        snapshot from buildCurrentSnapshot
 * @param {Array}  args.priorSummaries stored memory summaries (any schemaVersion)
 */
export const buildComparisonFindings = ({ current, priorSummaries = [] }) => {
  if (!current) return [];
  const findings = [];
  const priorSnapshots = priorSummaries.map(normalizeSnapshotFromMemory);
  const platform = current.primaryPlatform;
  const label = PLATFORM_LABELS[platform] || platform || "Account";

  // ── Self-over-time (same ad account) ─────────────────────────────────────
  const sameAccount = priorSnapshots
    .filter((s) => s.adAccountId && s.adAccountId === current.adAccountId)
    .sort(
      (a, b) =>
        new Date(b.completedAt || 0).getTime() -
        new Date(a.completedAt || 0).getTime()
    );
  const previous = sameAccount[0] || null;

  if (previous) {
    const delta = memoryDelta({ current, previous });

    // MEMORY-REGRESSION-001: CPA worsened materially.
    const cpaPct = delta.deltas.cpaPct;
    if (
      cpaPct != null &&
      cpaPct >= T.cpaRegressionPct &&
      current.conversions >= T.minConversionsForCpa
    ) {
      findings.push(
        finding({
          ruleId: "MEMORY-REGRESSION-001",
          platform,
          severity: cpaPct >= T.cpaRegressionHighPct ? "HIGH" : "MEDIUM",
          category: "Attribution & Reporting",
          title: `${label} CPA worsened ${cpaPct}% since your last audit`,
          detail: `CPA moved from $${previous.kpis.cpa} to $${current.kpis.cpa} (${cpaPct}% worse) since the ${String(previous.completedAt).slice(0, 10)} audit.`,
          evidence: {
            previousAuditId: delta.previousAuditId,
            previousCompletedAt: delta.previousCompletedAt,
            previousCpa: previous.kpis.cpa,
            currentCpa: current.kpis.cpa,
            cpaDeltaPct: cpaPct,
            healthScoreDelta: delta.healthScoreDelta,
            newCriticals: delta.newCriticals,
            confidence: current.conversions >= T.minConversionsForCpa ? "high" : "low",
            sampleNote: `${current.conversions} conversions in the current window`,
          },
          estimatedImpact: `CPA is up ${cpaPct}% vs your prior audit. Reverting the changes made since ${String(previous.completedAt).slice(0, 10)} or re-checking tracking is the fastest path back to prior efficiency.`,
          fixSteps: [
            "Compare what changed since the last audit: budget, targeting, creative, or tracking.",
            "Check for a tracking break — a sudden CPA jump is often under-attribution, not real.",
            "Roll back the highest-risk change and re-measure over 7 days.",
          ],
        })
      );
    }

    // MEMORY-IMPROVEMENT-001: criticals resolved or health score up.
    const improvedHealth =
      delta.healthScoreDelta != null &&
      delta.healthScoreDelta >= T.healthImprovementPoints;
    if (delta.resolvedCriticals.length > 0 || improvedHealth) {
      findings.push(
        finding({
          ruleId: "MEMORY-IMPROVEMENT-001",
          platform,
          severity: "LOW",
          category: "Attribution & Reporting",
          title: `${label} improved since your last audit`,
          detail: `${delta.resolvedCriticals.length} critical issue(s) resolved${
            improvedHealth ? `; health score up ${delta.healthScoreDelta} points` : ""
          } since ${String(previous.completedAt).slice(0, 10)}.`,
          evidence: {
            previousAuditId: delta.previousAuditId,
            resolvedCriticals: delta.resolvedCriticals,
            repeatedCriticals: delta.repeatedCriticals,
            healthScoreDelta: delta.healthScoreDelta,
            ctrDeltaPct: delta.deltas.ctrPct,
            cpaDeltaPct: delta.deltas.cpaPct,
          },
          estimatedImpact:
            "Progress confirmed vs your prior audit. Keep the changes that drove it; focus next on the repeated criticals that remain.",
          fixSteps: [
            "Lock in the changes that resolved the prior critical issues.",
            "Prioritize the repeated criticals that have not yet improved.",
          ],
        })
      );
    }
  }

  // ── Peer (different same-org account) ────────────────────────────────────
  const peerPick = pickPeer({ current, candidates: priorSnapshots });
  if (peerPick) {
    const cmp = peerComparison({ current, peer: peerPick.peer });
    const gap = cmp?.strongestGap;
    if (
      gap &&
      gap.metric === "CTR" &&
      gap.worseByPct != null &&
      gap.worseByPct >= T.peerCtrWorsePct &&
      cmp.confidence === "high"
    ) {
      findings.push(
        finding({
          ruleId: "PEER-CTR-001",
          platform,
          severity: gap.worseByPct >= 60 ? "HIGH" : "MEDIUM",
          category: CTR_CATEGORY[platform] || "Creative Performance",
          title: `${label} CTR is ${gap.worseByPct}% below a similar account in your portfolio`,
          detail: `This account's CTR is ${gap.current}% vs ${gap.peer}% on ${peerPick.peer.adAccountName || "a similar same-org account"} (${peerPick.reasons.join(", ")}). Same platform and comparable profile — the gap points to creative/relevance, not platform pricing.`,
          evidence: {
            peerAuditId: cmp.peer.auditId,
            peerAccount: cmp.peer.adAccountName,
            currentCtr: gap.current,
            peerCtr: gap.peer,
            ctrGapPct: gap.worseByPct,
            matchReasons: peerPick.reasons,
            deltas: cmp.deltas,
            confidence: cmp.confidence,
            sampleNote: cmp.sampleNote,
          },
          estimatedImpact: `Closing the CTR gap to your own better-performing ${label} account (${gap.peer}%) would lower CPC and CPA at the same spend. The winning account is the template — copy its hook, format, and offer framing.`,
          fixSteps: [
            `Pull the top creatives from ${peerPick.peer.adAccountName || "the better account"} and adapt their hooks/format here.`,
            "A/B test the adapted creative against the current best ad.",
            "Re-audit after 7 days to confirm the CTR gap is closing.",
          ],
        })
      );
    }
  }

  return findings;
};

export const __test__ = { T };
