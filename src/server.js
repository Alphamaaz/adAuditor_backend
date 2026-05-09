import "dotenv/config";
import app from "./app.js";
import { prisma } from "./lib/prisma.js";

const port = process.env.PORT || 5000;

app.listen(port, async () => {
  console.log(`Server running on port ${port}`);

  try {
    await prisma.$queryRaw`SELECT 1`;
    console.log("Database connected");
  } catch (error) {
    console.error("Database connection failed", error);
  }
});

