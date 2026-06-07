import { buildEvidencePacket } from "./evidencePacket.service.js";

const MAX_FINDINGS = 20;
const MAX_PRIOR_AUDITS = 3;

const compactFinding = (finding) => ({
  ruleId: finding.ruleId,
  platform: finding.platform,
  severity: finding.severity,
  category: finding.category,
  title: finding.title,
  detail: finding.detail,
  evidence: finding.evidence,
  estimatedImpact: finding.estimatedImpact,
  fixSteps: finding.fixSteps,
});

const compactIntake = (intakeResponses) =>
  (intakeResponses || []).reduce((acc, response) => {
    acc[response.section] = response.answers;
    return acc;
  }, {});

/**
 * Build the AI report context. Optionally include `priorAudits` —
 * compact summaries of recent completed audits for the same org so the AI
 * can reference trends ("CPA dropped vs your last audit"). Pass these in
 * via `priorAudits` from the caller (controller queries them, keeps this
 * function free of DB calls so it stays unit-testable).
 */
export const buildAiAuditContext = (audit, { priorAudits = [] } = {}) => {
  const sortedFindings = [...(audit.ruleFindings || [])].sort((left, right) => {
    const severityRank = {
      CRITICAL: 4,
      HIGH: 3,
      MEDIUM: 2,
      LOW: 1,
    };

    return (
      severityRank[right.severity] - severityRank[left.severity] ||
      left.ruleId.localeCompare(right.ruleId)
    );
  });

  const trimmedPriorAudits = priorAudits.slice(0, MAX_PRIOR_AUDITS);

  return {
    audit: {
      id: audit.id,
      selectedPlatforms: audit.selectedPlatforms,
      dataSource: audit.dataSource,
      healthScore: audit.healthScore,
      categoryScores: audit.categoryScores,
      uploadReadiness: audit.uploadReadiness,
      businessProfileSnapshot: audit.businessProfileSnapshot,
    },
    intakeResponses: compactIntake(audit.intakeResponses),
    normalizedSummary: audit.normalizedDataset?.summary || null,
    ruleFindings: sortedFindings.slice(0, MAX_FINDINGS).map(compactFinding),
    deterministicReport: audit.aiReport?.output || null,
    priorAudits: trimmedPriorAudits,
    // Curated, verified-facts-only packet. The narrative model should reason
    // over this; the surrounding fields remain for backward compatibility.
    evidencePacket: buildEvidencePacket(audit, { priorAudits: trimmedPriorAudits }),
    contextLimits: {
      maxFindingsSent: MAX_FINDINGS,
      maxPriorAudits: MAX_PRIOR_AUDITS,
      priorAuditsIncluded: trimmedPriorAudits.length,
      rawRowsIncluded: false,
      rawFilesIncluded: false,
    },
  };
};
