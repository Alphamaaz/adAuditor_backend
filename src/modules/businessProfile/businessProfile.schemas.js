import { z } from "zod";

const sectionASchema = z.object({
  businessType: z
    .enum(["eCommerce", "Lead Gen", "App Install", "Local", "B2B SaaS", "Other"])
    .nullable()
    .optional(),
  monthlyBudget: z.number().positive().nullable().optional(),
  targetCpa: z.number().positive().nullable().optional(),
  targetRoas: z.number().positive().nullable().optional(),
  avgOrderValue: z.number().positive().nullable().optional(),
  blendedCac: z.number().positive().nullable().optional(),
  productsServices: z.string().max(500).nullable().optional(),
  geoMarkets: z.array(z.string()).optional().default([]),
  campaignAge: z
    .enum(["<1 month", "1-3 months", "3-6 months", "6+ months"])
    .nullable()
    .optional(),
  campaignObjective: z
    .array(z.enum(["Sales", "Leads", "Traffic", "Awareness", "App Installs"]))
    .optional()
    .default([]),
  // Added for the lightweight new-audit context flow. Kept here so the
  // edit-profile path and the audit snapshot share one shape.
  mainGoal: z
    .enum(["leads", "sales", "roas", "cpa_reduction", "traffic", "awareness"])
    .nullable()
    .optional(),
  // Brand terms / company name — comma or space separated. Powers the
  // Google brand-separation and cross-platform cannibalization rules.
  brandTerms: z.string().max(300).nullable().optional(),
});

const sectionBSchema = z.object({
  pixelInstalled: z.enum(["Yes", "No", "Unsure"]).nullable().optional(),
  correctConversionEvent: z.enum(["Yes", "No", "Unsure"]).nullable().optional(),
  utmConsistency: z.enum(["Yes", "No", "Inconsistently"]).nullable().optional(),
  crossReferencesGa4: z.enum(["Yes", "No"]).nullable().optional(),
  serverSideTracking: z.enum(["Yes", "No", "In progress"]).nullable().optional(),
});

const sectionCSchema = z.object({
  bestEverCpa: z.number().positive().nullable().optional(),
  bestEverRoas: z.number().positive().nullable().optional(),
  avgCtr90Days: z.number().min(0).max(100).nullable().optional(),
  avgCpm90Days: z.number().positive().nullable().optional(),
  landingPageConversionRate: z.number().min(0).max(100).nullable().optional(),
  historicalSpend: z
    .enum(["<$1K", "$1K-$10K", "$10K-$100K", "$100K+"])
    .nullable()
    .optional(),
});

export const upsertBusinessProfileSchema = z.object({
  sectionA: sectionASchema.optional().default({}),
  sectionB: sectionBSchema.optional().default({}),
  sectionC: sectionCSchema.optional().default({}),
});
