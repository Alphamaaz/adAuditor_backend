export const getPlatformAnswers = (audit, platform) => {
  const intakeResponse = audit.intakeResponses?.find(
    (response) => response.section === `PLATFORM_${platform}`
  );
  return intakeResponse?.answers || {};
};

export const getPlatformRecords = (dataset, platform) =>
  dataset?.data?.platforms?.[platform]?.records || [];

/**
 * Returns records filtered to a specific entity level. Reads the new
 * `byLevel` map first (post-entity-level normalization), falls back to
 * filtering `records` by the `level` field (legacy datasets).
 */
export const getRecordsByLevel = (dataset, platform, level) => {
  const platformData = dataset?.data?.platforms?.[platform];
  if (!platformData) return [];

  if (platformData.byLevel?.[level]) return platformData.byLevel[level];

  return (platformData.records || []).filter(
    (record) => record.level === level
  );
};

export const getPlatformSummary = (dataset, platform) =>
  dataset?.summary?.platforms?.[platform] || {
    uploadedFiles: 0,
    rowCount: 0,
    spend: 0,
    impressions: 0,
    clicks: 0,
    conversions: 0,
    reach: 0,
  };

export const getBusinessProfile = (audit) => {
  const snapshot = audit.businessProfileSnapshot;
  if (!snapshot) return null;
  return {
    sectionA: snapshot.sectionA || {},
    sectionB: snapshot.sectionB || {},
    sectionC: snapshot.sectionC || {},
  };
};

export const isPausedStatus = (status) => {
  const value = String(status || "").toLowerCase();
  if (!value) return false;
  return (
    value.includes("paused") ||
    value.includes("not delivering") ||
    value === "off"
  );
};

export const isLearningStatus = (status) =>
  String(status || "").toLowerCase().includes("learning");
