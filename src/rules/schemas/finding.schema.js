import { z } from "zod";
import { RuleIdSchema, RuleSeveritySchema, RulePlatformSchema } from "./rule.schema.js";

export const FindingSchema = z.object({
  ruleId: RuleIdSchema,
  platform: RulePlatformSchema,
  severity: RuleSeveritySchema,
  category: z.string().min(1),
  title: z.string().min(1),
  detail: z.string().optional(),
  evidence: z.record(z.string(), z.any()).optional(),
  estimatedImpact: z.string().optional(),
  fixSteps: z.array(z.string()).optional(),
});
