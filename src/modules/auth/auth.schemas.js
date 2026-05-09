import { z } from "zod";

const emailSchema = z
  .string()
  .trim()
  .email()
  .transform((v) => v.toLowerCase());

const otpSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, "Verification code must be a 6-digit number.");

const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters.")
  .max(128, "Password must be at most 128 characters.");

export const signupSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  email: emailSchema,
  password: passwordSchema,
  organizationName: z.string().trim().min(1).max(160).optional(),
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
});

export const verifyEmailSchema = z.object({
  email: emailSchema,
  otp: otpSchema,
});

export const resendOtpSchema = z.object({
  email: emailSchema,
});

export const forgotPasswordSchema = z.object({
  email: emailSchema,
});

export const resetPasswordSchema = z.object({
  email: emailSchema,
  otp: otpSchema,
  newPassword: passwordSchema,
});

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Current password is required."),
    newPassword: passwordSchema,
  })
  .refine((data) => data.currentPassword !== data.newPassword, {
    message: "New password must be different from the current password.",
    path: ["newPassword"],
  });

export const updateProfileSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    organizationName: z.string().trim().min(1).max(160).optional(),
  })
  .refine((data) => data.name || data.organizationName, {
    message: "At least one profile field is required.",
  });
