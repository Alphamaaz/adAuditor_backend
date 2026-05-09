import { calculateUploadReadiness } from "./uploadReadiness.service.js";

export const serializeAdAccount = (adAccount) => ({
  id: adAccount.id,
  name: adAccount.name,
  platform: adAccount.platform,
  externalId: adAccount.externalId,
  createdAt: adAccount.createdAt,
});

export const serializeAudit = (audit) => ({
  id: audit.id,
  organizationId: audit.organizationId,
  adAccountId: audit.adAccountId,
  status: audit.status,
  selectedPlatforms: audit.selectedPlatforms,
  dataSource: audit.dataSource,
  healthScore: audit.healthScore,
  categoryScores: audit.categoryScores,
  startedAt: audit.startedAt,
  completedAt: audit.completedAt,
  createdAt: audit.createdAt,
  updatedAt: audit.updatedAt,
  adAccount: audit.adAccount ? serializeAdAccount(audit.adAccount) : null,
  intakeResponses: audit.intakeResponses
    ? audit.intakeResponses.map(serializeIntakeResponse)
    : undefined,
  uploadedFiles: audit.uploadedFiles
    ? audit.uploadedFiles.map(serializeUploadedFile)
    : undefined,
  ruleFindings: audit.ruleFindings
    ? audit.ruleFindings.map(serializeRuleFinding)
    : undefined,
  normalizedDataset: audit.normalizedDataset
    ? serializeNormalizedDataset(audit.normalizedDataset)
    : undefined,
  aiReport: audit.aiReport ? serializeAiReport(audit.aiReport) : undefined,
  pdfReports: audit.pdfReports
    ? audit.pdfReports.map(serializePdfReport)
    : undefined,
  uploadReadiness: audit.uploadedFiles
    ? calculateUploadReadiness(audit)
    : undefined,
});

export const serializeIntakeResponse = (intakeResponse) => ({
  id: intakeResponse.id,
  auditId: intakeResponse.auditId,
  section: intakeResponse.section,
  answers: intakeResponse.answers,
  createdAt: intakeResponse.createdAt,
  updatedAt: intakeResponse.updatedAt,
});

export const serializeUploadedFile = (uploadedFile) => ({
  id: uploadedFile.id,
  auditId: uploadedFile.auditId,
  platform: uploadedFile.platform,
  reportType: uploadedFile.reportType,
  originalName: uploadedFile.originalName,
  mimeType: uploadedFile.mimeType,
  sizeBytes: uploadedFile.sizeBytes,
  status: uploadedFile.status,
  validation: uploadedFile.validation,
  createdAt: uploadedFile.createdAt,
  updatedAt: uploadedFile.updatedAt,
});

export const serializeNormalizedDataset = (normalizedDataset) => ({
  id: normalizedDataset.id,
  auditId: normalizedDataset.auditId,
  summary: normalizedDataset.summary,
  createdAt: normalizedDataset.createdAt,
  updatedAt: normalizedDataset.updatedAt,
});

export const serializeRuleFinding = (finding) => ({
  id: finding.id,
  auditId: finding.auditId,
  ruleId: finding.ruleId,
  platform: finding.platform,
  severity: finding.severity,
  category: finding.category,
  title: finding.title,
  detail: finding.detail,
  evidence: finding.evidence,
  estimatedImpact: finding.estimatedImpact,
  fixSteps: finding.fixSteps,
  createdAt: finding.createdAt,
});

export const serializeAiReport = (aiReport) => ({
  id: aiReport.id,
  auditId: aiReport.auditId,
  provider: aiReport.provider,
  model: aiReport.model,
  promptMeta: aiReport.promptMeta,
  output: aiReport.output,
  createdAt: aiReport.createdAt,
  updatedAt: aiReport.updatedAt,
});

export const serializePdfReport = (pdfReport) => ({
  id: pdfReport.id,
  auditId: pdfReport.auditId,
  version: pdfReport.version,
  downloadUrl: `/api/audits/${pdfReport.auditId}/pdf/${pdfReport.id}/download`,
  createdAt: pdfReport.createdAt,
});
