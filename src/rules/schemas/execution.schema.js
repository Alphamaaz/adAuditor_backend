import { z } from "zod";
import { RuleIdSchema, RulePlanTierSchema } from "./rule.schema.js";

export const RuleExecutionStatusSchema = z.enum([
  "FIRED",
  "PASSED",
  "SKIPPED",
  "ERROR",
]);

export const RuleExecutionPayloadSchema = z.object({
  auditId: z.string(),
  ruleId: RuleIdSchema,
  ruleVersion: z.string(),
  status: RuleExecutionStatusSchema,
  durationMs: z.number().nonnegative(),
  findingId: z.string().nullable().optional(),
  errorMessage: z.string().nullable().optional(),
  evidenceSummary: z.record(z.string(), z.any()).nullable().optional(),
  contextVersion: z.string(),
  planTier: RulePlanTierSchema,
});
