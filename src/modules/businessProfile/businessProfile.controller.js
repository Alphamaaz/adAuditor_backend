import { prisma } from "../../lib/prisma.js";
import { getOrganizationId } from "../../utils/requestContext.js";

export const getBusinessProfile = async (req, res) => {
  const organizationId = getOrganizationId(req);

  const profile = await prisma.businessProfile.findFirst({
    where: { organizationId },
  });

  res.json({ status: "success", data: profile ?? null });
};

export const upsertBusinessProfile = async (req, res) => {
  const organizationId = getOrganizationId(req);
  const answers = req.body; // already validated by Zod middleware

  const profile = await prisma.businessProfile.upsert({
    where: { organizationId },
    create: { organizationId, userId: req.user.id, answers },
    update: { answers },
  });

  res.json({ status: "success", data: profile });
};
