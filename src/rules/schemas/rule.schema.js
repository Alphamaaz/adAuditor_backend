import { z } from "zod";

export const RuleIdSchema = z
  .string()
  .regex(
    /^[A-Z]+(-[A-Z]+)*-\d{3}$/,
    "Rule IDs must look like META-AUDIENCE-OVERLAP-001"
  );

export const RuleSeveritySchema = z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]);

export const RulePlanTierSchema = z.enum([
  "free",
  "starter",
  "pro",
  "team",
  "agency",
  "agency_plus",
]);

export const RuleConfidenceSchema = z.enum(["high", "medium", "low"]);

export const RuleCostSchema = z.enum(["cheap", "moderate", "expensive"]);

export const RulePlatformSchema = z.enum([
  "META",
  "GOOGLE",
  "TIKTOK",
  "CROSS_PLATFORM",
]);

export const RuleMetadataSchema = z.object({
  id: RuleIdSchema,
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  platforms: z.array(RulePlatformSchema).nonempty(),
  category: z.string().min(1),
  severity: RuleSeveritySchema,
  minPlanTier: RulePlanTierSchema.default("free"),
  estimatedImpactRange: z.object({
    min: z.number().nonnegative(),
    max: z.number().nonnegative(),
  }),
  confidence: RuleConfidenceSchema.default("high"),
  requiresHistory: z.boolean().default(false),
  requiresBenchmarkData: z.boolean().default(false),
  costToEvaluate: RuleCostSchema.default("cheap"),
  tags: z.array(z.string()).default([]),
  contextVersion: z.literal("v1"),
  deprecated: z.boolean().default(false),
  deprecatedReason: z.string().optional(),
  replacedBy: RuleIdSchema.optional(),
  // Bridge during refactor: emitted finding uses this id to preserve byte-equivalence
  // with legacy engine. Remove after a data migration renames stored findings.
  legacyRuleId: z.string().optional(),
});

// Zod 4 removed chained .args/.returns; we validate `eval` shape in the
// registry via `typeof === "function"` rather than via Zod.

export const PLAN_TIER_RANK = {
  free: 0,
  starter: 1,
  pro: 2,
  team: 3,
  agency: 4,
  agency_plus: 5,
};
