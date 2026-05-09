import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis;
const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
});
const logQueries = process.env.PRISMA_LOG_QUERIES === "true";

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    adapter,
    log: logQueries ? ["query", "error", "warn"] : ["error", "warn"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
