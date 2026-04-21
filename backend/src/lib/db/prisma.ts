import { PrismaPg } from "@prisma/adapter-pg";
import { env } from "../env";
import { PrismaClient } from "../../generated/prisma/client";
import { logger } from "../logger";

const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });
export const prisma = new PrismaClient({ adapter });

export async function connectDb(): Promise<void> {
  await prisma.$connect();
  logger.info("Connected to Postgres");
}

export async function disconnectDb(): Promise<void> {
  await prisma.$disconnect();
  logger.info("Disconnected from Postgres");
}
