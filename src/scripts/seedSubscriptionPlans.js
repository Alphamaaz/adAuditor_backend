import "dotenv/config";
import { prisma } from "../lib/prisma.js";
import { seedDefaultSubscriptionPlans } from "../modules/plans/plan.service.js";

const main = async () => {
  const plans = await seedDefaultSubscriptionPlans();
  console.log(
    `Seeded subscription plans: ${plans.map((plan) => plan.slug).join(", ")}`
  );
};

main()
  .catch((error) => {
    console.error("Failed to seed subscription plans", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
