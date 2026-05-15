import { REQUIRED_UPLOAD_REPORTS } from "./uploadRequirements.js";

const getValidatedReportTypes = (uploadedFiles, platform) =>
  new Set(
    (uploadedFiles || [])
      .filter(
        (file) => file.platform === platform && file.status === "VALIDATED"
      )
      .map((file) => file.reportType)
  );

export const calculateUploadReadiness = (audit) => {
  const selectedPlatforms = audit.selectedPlatforms || [];
  // OAuth audits fetch all available data via API — no CSV files required.
  const isOAuth = audit.dataSource !== "MANUAL_UPLOAD";
  const platformReadiness = {};
  let validatedFileCount = 0;
  let requiredCount = 0;
  let completedRequiredCount = 0;

  for (const platform of selectedPlatforms) {
    const requiredReports = REQUIRED_UPLOAD_REPORTS[platform] || [];

    if (isOAuth) {
      requiredCount += requiredReports.length;
      completedRequiredCount += requiredReports.length;
      validatedFileCount += 1;

      platformReadiness[platform] = {
        status: "FULL",
        validatedFileCount: 1,
        requiredReports,
        uploadedReports: requiredReports,
        missingReports: [],
        missingCount: 0,
        requiredCount: requiredReports.length,
      };
    } else {
      const validatedReportTypes = getValidatedReportTypes(
        audit.uploadedFiles || [],
        platform
      );
      const uploadedReports = requiredReports.filter((report) =>
        validatedReportTypes.has(report.id)
      );
      const missingReports = requiredReports.filter(
        (report) => !validatedReportTypes.has(report.id)
      );
      const platformValidatedFileCount = (audit.uploadedFiles || []).filter(
        (file) => file.platform === platform && file.status === "VALIDATED"
      ).length;

      validatedFileCount += platformValidatedFileCount;
      requiredCount += requiredReports.length;
      completedRequiredCount += uploadedReports.length;

      platformReadiness[platform] = {
        status: missingReports.length === 0 ? "FULL" : "LIMITED",
        validatedFileCount: platformValidatedFileCount,
        requiredReports,
        uploadedReports,
        missingReports,
        missingCount: missingReports.length,
        requiredCount: requiredReports.length,
      };
    }
  }

  const fullAuditReady =
    selectedPlatforms.length > 0 &&
    Object.values(platformReadiness).every((platform) => platform.status === "FULL");
  const hasAnyValidatedUpload = validatedFileCount > 0;
  const mode = fullAuditReady
    ? "FULL"
    : hasAnyValidatedUpload
      ? "LIMITED"
      : "NOT_READY";

  return {
    mode,
    fullAuditReady,
    limitedAuditAvailable: mode === "LIMITED",
    canRunAudit: hasAnyValidatedUpload,
    validatedFileCount,
    requiredCount,
    completedRequiredCount,
    missingRequiredCount: Math.max(0, requiredCount - completedRequiredCount),
    platforms: platformReadiness,
  };
};
