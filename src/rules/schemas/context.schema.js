import { z } from "zod";

export const CONTEXT_VERSION = "v1";

export const PlatformAnswersSchema = z.record(z.string(), z.any());

export const NormalizedRecordSchema = z
  .object({
    level: z
      .enum(["account", "campaign", "adset", "ad", "keyword", "search_term"])
      .optional(),
    name: z.string().optional(),
    status: z.string().optional(),
    spend: z.number().nonnegative().optional(),
    impressions: z.number().nonnegative().optional(),
    clicks: z.number().nonnegative().optional(),
    conversions: z.number().nonnegative().optional(),
    results: z.number().nonnegative().optional(),
    budget: z.number().nonnegative().optional(),
    frequency: z.number().nonnegative().optional(),
    roas: z.number().nonnegative().optional(),
    reach: z.number().nonnegative().optional(),
    campaignName: z.string().optional(),
    qualityRanking: z.string().optional(),
    engagementRanking: z.string().optional(),
    conversionRanking: z.string().optional(),
    learningPhase: z.string().optional(),
  })
  .passthrough();

export const PlatformDataSchema = z.object({
  records: z.array(NormalizedRecordSchema).default([]),
  byLevel: z
    .record(z.string(), z.array(NormalizedRecordSchema))
    .optional(),
});

export const PlatformSummarySchema = z.object({
  uploadedFiles: z.number().nonnegative().default(0),
  rowCount: z.number().nonnegative().default(0),
  spend: z.number().nonnegative().default(0),
  impressions: z.number().nonnegative().default(0),
  clicks: z.number().nonnegative().default(0),
  conversions: z.number().nonnegative().default(0),
  reach: z.number().nonnegative().default(0),
});

export const BusinessProfileSnapshotSchema = z
  .object({
    sectionA: z.record(z.string(), z.any()).default({}),
    sectionB: z.record(z.string(), z.any()).default({}),
    sectionC: z.record(z.string(), z.any()).default({}),
  })
  .partial()
  .default({ sectionA: {}, sectionB: {}, sectionC: {} });

export const IntakeResponseSchema = z.object({
  section: z.string(),
  answers: z.record(z.string(), z.any()),
});

export const PriorAuditFindingSchema = z.object({
  ruleId: z.string(),
  severity: z.string(),
});

export const PriorAuditSchema = z.object({
  auditId: z.string(),
  completedAt: z.string(),
  findings: z.array(PriorAuditFindingSchema),
});

export const AuditContextSchema = z
  .object({
    audit: z.object({
      id: z.string(),
      selectedPlatforms: z
        .array(z.enum(["META", "GOOGLE", "TIKTOK"]))
        .default([]),
      dataSource: z.string().nullable().optional(),
      businessProfileSnapshot: BusinessProfileSnapshotSchema.nullable().optional(),
      intakeResponses: z.array(IntakeResponseSchema).default([]),
      uploadReadiness: z.object({ mode: z.string() }).partial().optional(),
    }),
    dataset: z
      .object({
        summary: z
          .object({
            totals: z.record(z.string(), z.any()).optional(),
            platforms: z.record(z.string(), PlatformSummarySchema).optional(),
          })
          .optional(),
        data: z.object({
          platforms: z.record(z.string(), PlatformDataSchema),
        }),
      })
      .nullable(),
    priorAudits: z.array(PriorAuditSchema).default([]),
    benchmarks: z.record(z.string(), z.any()).optional(),
    now: z.string(),
  })
  .strict();
