import { prisma } from "../lib/prisma.js";

const DEFAULT_PLANS = [
  {
    name: "Starter",
    slug: "starter",
    description: "For small teams validating one ad platform at a time with focused monthly audit volume.",
    priceCents: 2000,
    currency: "usd",
    monthlyAuditLimit: 3,
    platformLimit: 1,
    historyDays: 30,
    features: {
      pdfExport: true,
      manualUpload: true,
      oauthConnections: false,
      includedPlatforms: ["META", "GOOGLE", "TIKTOK"],
      aiNarrative: "manual",
    },
    isActive: true,
  },
  {
    name: "Pro",
    slug: "pro",
    description: "For agencies and operators running multi-platform audits across active client accounts.",
    priceCents: 4900,
    currency: "usd",
    monthlyAuditLimit: 15,
    platformLimit: 3,
    historyDays: 365,
    features: {
      pdfExport: true,
      manualUpload: true,
      oauthConnections: true,
      includedPlatforms: ["META", "GOOGLE", "TIKTOK"],
      aiNarrative: "automatic",
    },
    isActive: true,
  },
  {
    name: "Agency",
    slug: "agency",
    description: "For growing agencies that need higher usage, client account capacity, and priority support.",
    priceCents: 14900,
    currency: "usd",
    monthlyAuditLimit: null,
    platformLimit: 3,
    historyDays: null,
    features: {
      pdfExport: true,
      manualUpload: true,
      oauthConnections: true,
      teamSeats: true,
      prioritySupport: true,
      includedPlatforms: ["META", "GOOGLE", "TIKTOK"],
      aiNarrative: "automatic",
    },
    isActive: true,
  },
];

async function main() {
  console.log("Seeding subscription plans...");
  for (const plan of DEFAULT_PLANS) {
    await prisma.subscriptionPlan.upsert({
      where: { slug: plan.slug },
      update: plan,
      create: plan,
    });
    console.log(`- Seeded/Updated plan: ${plan.name}`);
  }
  console.log("Seeding complete!");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
