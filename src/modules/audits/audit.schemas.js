import { z } from "zod";

export const platformSchema = z.enum(["META", "GOOGLE", "TIKTOK"]);

export const dataSourceSchema = z.enum(["MANUAL_UPLOAD", "OAUTH"]);

// Lightweight audit context collected in the new-audit flow. Replaces the
// long /onboarding business profile as the pre-audit data source. Every
// field is optional so the audit never hard-blocks on missing context —
// the engine + AI degrade gracefully when fields are absent.
export const auditContextSchema = z
  .object({
    businessType: z
      .enum(["eCommerce", "Lead Gen", "App Install", "Local", "B2B SaaS", "Other"])
      .nullable()
      .optional(),
    monthlyBudget: z.number().positive().nullable().optional(),
    mainGoal: z
      .enum(["leads", "sales", "roas", "cpa_reduction", "traffic", "awareness"])
      .nullable()
      .optional(),
    auditFocus: z
      .enum([
        "lower_cpa",
        "improve_ctr",
        "increase_roas",
        "more_leads",
        "diagnose_performance",
        "other",
      ])
      .nullable()
      .optional(),
    auditFocusOther: z.string().trim().max(240).nullable().optional(),
    targetCpa: z.number().positive().nullable().optional(),
    targetRoas: z.number().positive().nullable().optional(),
    // Comma/space separated brand terms or company name. Drives the Google
    // brand-separation + cross-platform cannibalization rules.
    brandTerms: z.string().trim().max(300).nullable().optional(),
  })
  .optional();

export const createAuditSetupSchema = z.object({
  accountName: z.string().trim().min(1).max(160),
  selectedPlatforms: z.array(platformSchema).min(1).max(3),
  dataSource: dataSourceSchema,
  context: auditContextSchema,
});

const answerValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
  z.null(),
]);

const platformAnswersSchema = z.record(z.string(), answerValueSchema);

export const submitPlatformIntakeSchema = z.object({
  responses: z
    .object({
      META: platformAnswersSchema.optional(),
      GOOGLE: platformAnswersSchema.optional(),
      TIKTOK: platformAnswersSchema.optional(),
    })
    .refine((responses) => Object.keys(responses).length > 0, {
      message: "At least one platform response is required.",
    }),
});
