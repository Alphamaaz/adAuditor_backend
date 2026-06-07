import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.js";
import { validateBody } from "../../middlewares/validate.js";
import {
  createCheckoutBodySchema,
  createPortalBodySchema,
} from "./billing.schemas.js";
import {
  postCreateCheckout,
  postCreatePortal,
} from "./billing.controller.js";

const router = Router();

router.use(requireAuth);
router.post(
  "/checkout",
  validateBody(createCheckoutBodySchema),
  postCreateCheckout
);
router.post(
  "/portal",
  validateBody(createPortalBodySchema),
  postCreatePortal
);

export default router;
