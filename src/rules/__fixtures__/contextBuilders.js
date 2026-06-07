/**
 * Test fixture builders for ContextV1.
 *
 * These produce minimal valid AuditContext shapes for rule unit tests.
 * Override fields by passing overrides to each builder.
 *
 * Every returned context is Zod-validated against AuditContextSchema so
 * fixture drift surfaces at test time, not in production.
 */

import { AuditContextSchema } from "../schemas/context.schema.js";

const FROZEN_NOW = "2026-05-26T12:00:00.000Z";

const deepMerge = (base, overrides) => {
  if (overrides == null) return base;
  if (Array.isArray(base) || Array.isArray(overrides)) return overrides ?? base;
  if (typeof base !== "object" || typeof overrides !== "object") return overrides;
  const out = { ...base };
  for (const key of Object.keys(overrides)) {
    out[key] = deepMerge(base[key], overrides[key]);
  }
  return out;
};

export const buildMetaIntake = (answers = {}) => ({
  section: "PLATFORM_META",
  answers,
});

export const buildDataset = ({ metaRecords = [], googleRecords = [], tiktokRecords = [] } = {}) => ({
  summary: {
    totals: { spend: 0, conversions: 0, uploadedFiles: 0, rowCount: 0 },
    platforms: {
      META: { uploadedFiles: 0, rowCount: metaRecords.length, spend: 0, impressions: 0, clicks: 0, conversions: 0, reach: 0 },
      GOOGLE: { uploadedFiles: 0, rowCount: googleRecords.length, spend: 0, impressions: 0, clicks: 0, conversions: 0, reach: 0 },
      TIKTOK: { uploadedFiles: 0, rowCount: tiktokRecords.length, spend: 0, impressions: 0, clicks: 0, conversions: 0, reach: 0 },
    },
  },
  data: {
    platforms: {
      META: { records: metaRecords },
      GOOGLE: { records: googleRecords },
      TIKTOK: { records: tiktokRecords },
    },
  },
});

export const buildContext = (overrides = {}) => {
  const base = {
    audit: {
      id: "aud_test_1",
      selectedPlatforms: ["META"],
      dataSource: "MANUAL_UPLOAD",
      businessProfileSnapshot: { sectionA: {}, sectionB: {}, sectionC: {} },
      intakeResponses: [buildMetaIntake({})],
      uploadReadiness: { mode: "FULL" },
    },
    dataset: buildDataset({ metaRecords: [{ level: "campaign", name: "Test", spend: 100 }] }),
    priorAudits: [],
    benchmarks: {},
    now: FROZEN_NOW,
  };
  const merged = deepMerge(base, overrides);
  // Schema-validate so fixture drift fails loudly at test time.
  const parsed = AuditContextSchema.safeParse(merged);
  if (!parsed.success) {
    throw new Error(
      "Fixture failed AuditContextSchema validation:\n" +
        JSON.stringify(parsed.error.issues, null, 2)
    );
  }
  return parsed.data;
};

export const buildContextWithNoMetaData = (overrides = {}) =>
  buildContext({
    dataset: buildDataset({ metaRecords: [] }),
    ...overrides,
  });

export const buildContextWithMetaAnswers = (answers, overrides = {}) =>
  buildContext({
    audit: { intakeResponses: [buildMetaIntake(answers)] },
    ...overrides,
  });
