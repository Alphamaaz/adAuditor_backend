import { z } from "zod";

const slugSchema = z
  .string()
  .trim()
  .min(2)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: "Slug must use lowercase letters, numbers, and hyphens.",
  });

const currencySchema = z
  .string()
  .trim()
  .length(3)
  .transform((value) => value.toLowerCase());

const nullableLimitSchema = z.number().int().positive().nullable().optional();
const featuresSchema = z.record(z.string(), z.unknown()).optional();

export const createPlanSchema = z.object({
  name: z.string().trim().min(2).max(120),
  slug: slugSchema.optional(),
  description: z.string().trim().max(500).nullable().optional(),
  priceCents: z.number().int().min(0),
  currency: currencySchema.default("usd"),
  monthlyAuditLimit: nullableLimitSchema,
  platformLimit: nullableLimitSchema,
  historyDays: nullableLimitSchema,
  features: featuresSchema,
  stripePriceId: z.string().trim().min(1).max(255).nullable().optional(),
  isActive: z.boolean().optional(),
});

export const updatePlanSchema = createPlanSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  {
    message: "At least one field is required.",
  }
);
