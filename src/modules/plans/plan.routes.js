import { Router } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { requireAuth, requireInternalRole } from "../../middlewares/auth.js";
import { validateBody } from "../../middlewares/validate.js";
import { createPlanSchema, updatePlanSchema } from "./plan.schemas.js";
import {
  createPlan,
  getMyPlanAndUsage,
  listAdminPlans,
  listPublicPlans,
  seedDefaultPlans,
  updatePlan,
} from "./plan.controller.js";

export const publicPlanRoutes = Router();
export const adminPlanRoutes = Router();
export const meRoutes = Router();

publicPlanRoutes.get("/", asyncHandler(listPublicPlans));

meRoutes.use(requireAuth);
meRoutes.get("/me", asyncHandler(getMyPlanAndUsage));

adminPlanRoutes.use(requireAuth, requireInternalRole("SUPER_ADMIN"));
adminPlanRoutes.get("/", asyncHandler(listAdminPlans));
adminPlanRoutes.post("/", validateBody(createPlanSchema), asyncHandler(createPlan));
adminPlanRoutes.post("/seed-defaults", asyncHandler(seedDefaultPlans));
adminPlanRoutes.patch(
  "/:planId",
  validateBody(updatePlanSchema),
  asyncHandler(updatePlan)
);
