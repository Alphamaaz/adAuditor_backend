import { z } from "zod";

export const createCheckoutBodySchema = z.object({
  planId: z.string().uuid(),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
});

export const createPortalBodySchema = z.object({
  returnUrl: z.string().url(),
});
