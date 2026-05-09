import { z } from "zod";

export const platformSchema = z.enum(["META", "GOOGLE", "TIKTOK"]);

export const dataSourceSchema = z.enum(["MANUAL_UPLOAD", "OAUTH"]);

export const createAuditSetupSchema = z.object({
  accountName: z.string().trim().min(1).max(160),
  selectedPlatforms: z.array(platformSchema).min(1).max(3),
  dataSource: dataSourceSchema,
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
