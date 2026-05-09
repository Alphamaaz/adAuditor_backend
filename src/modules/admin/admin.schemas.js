import { z } from "zod";

export const listUsersSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  search: z.string().trim().optional(),
  status: z.enum(["PENDING", "ACTIVE", "SUSPENDED", "DELETED"]).optional(),
  role: z.enum(["USER", "SUPER_ADMIN", "SUPPORT_ADMIN"]).optional(),
});

export const updateUserStatusSchema = z.object({
  status: z.enum(["ACTIVE", "SUSPENDED", "DELETED"]),
});

export const impersonateUserSchema = z.object({
  userId: z.string().uuid(),
  reason: z.string().trim().max(500).optional(),
});

export const listOrganizationsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  search: z.string().trim().optional(),
});

export const updateOrganizationPlanSchema = z.object({
  planId: z.string().uuid().nullable(),
  reason: z.string().trim().min(1).max(500).optional(),
});
