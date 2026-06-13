import { Router } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { requireAuth, requireInternalRole } from "../../middlewares/auth.js";
import { validateBody, validateQuery } from "../../middlewares/validate.js";
import {
  getStats,
  listUsers,
  updateUserStatus,
  deleteUser,
  listOrganizations,
  impersonateUser,
  stopImpersonation,
  updateOrganizationPlan,
} from "./admin.controller.js";
import {
  listUsersSchema,
  updateUserStatusSchema,
  listOrganizationsSchema,
  impersonateUserSchema,
  updateOrganizationPlanSchema,
} from "./admin.schemas.js";

const router = Router();

// All admin routes require SUPER_ADMIN role
// Note: stop-impersonation is allowed for anyone who HAS the admin cookie, 
// even if their current session is a regular user.
router.get("/stats", requireAuth, requireInternalRole("SUPER_ADMIN"), asyncHandler(getStats));

router.get("/debug-count", requireAuth, requireInternalRole("SUPER_ADMIN"), asyncHandler(async (req, res) => {
  const count = await prisma.user.count();
  res.json({ count });
}));


router.get("/users", requireAuth, requireInternalRole("SUPER_ADMIN"), validateQuery(listUsersSchema), asyncHandler(listUsers));
router.patch(
  "/users/:userId/status",
  requireAuth, 
  requireInternalRole("SUPER_ADMIN"),
  validateBody(updateUserStatusSchema),
  asyncHandler(updateUserStatus)
);

router.delete(
  "/users/:userId",
  requireAuth,
  requireInternalRole("SUPER_ADMIN"),
  asyncHandler(deleteUser)
);

router.get(
  "/organizations",
  requireAuth,
  requireInternalRole("SUPER_ADMIN"),
  validateQuery(listOrganizationsSchema),
  asyncHandler(listOrganizations)
);

router.post(
  "/impersonate",
  requireAuth,
  requireInternalRole("SUPER_ADMIN"),
  validateBody(impersonateUserSchema),
  asyncHandler(impersonateUser)
);

router.post(
  "/stop-impersonation",
  asyncHandler(stopImpersonation)
);

router.patch(
  "/organizations/:organizationId/plan",
  requireAuth,
  requireInternalRole("SUPER_ADMIN"),
  validateBody(updateOrganizationPlanSchema),
  asyncHandler(updateOrganizationPlan)
);


export default router;
