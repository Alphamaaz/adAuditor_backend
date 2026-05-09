import { Router } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { requireAuth } from "../../middlewares/auth.js";
import { validateBody } from "../../middlewares/validate.js";
import { upsertBusinessProfileSchema } from "./businessProfile.schemas.js";
import {
  getBusinessProfile,
  upsertBusinessProfile,
} from "./businessProfile.controller.js";

const router = Router();

router.use(requireAuth);

router.get("/", asyncHandler(getBusinessProfile));
router.post(
  "/",
  validateBody(upsertBusinessProfileSchema),
  asyncHandler(upsertBusinessProfile)
);

export default router;
