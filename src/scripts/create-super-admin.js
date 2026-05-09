import { prisma } from "../lib/prisma.js";
import { hashPassword } from "../utils/password.js";

async function main() {
  const email = "adauditor@admin.com";
  const password = "admin@123";
  const name = "Super Admin";

  console.log(`Creating super admin: ${email}...`);

  const passwordHash = await hashPassword(password);

  try {
    const user = await prisma.user.upsert({
      where: { email },
      update: {
        internalRole: "SUPER_ADMIN",
        status: "ACTIVE",
        passwordHash,
      },
      create: {
        email,
        name,
        passwordHash,
        status: "ACTIVE",
        internalRole: "SUPER_ADMIN",
      },
    });

    console.log("User created/updated successfully:", user.id);

    // Ensure they have an organization
    const existingMembership = await prisma.organizationMember.findFirst({
      where: { userId: user.id },
    });

    if (!existingMembership) {
      const org = await prisma.organization.create({
        data: {
          name: "Admin Headquarters",
          ownerId: user.id,
        },
      });

      await prisma.organizationMember.create({
        data: {
          userId: user.id,
          organizationId: org.id,
          role: "OWNER",
        },
      });
      console.log("Organization created:", org.name);
    }

    console.log("\nDone! You can now login with:");
    console.log(`Email: ${email}`);
    console.log(`Password: ${password}`);
  } catch (error) {
    console.error("Error creating super admin:", error);
  } finally {
    await prisma.$disconnect();
  }
}

main();
