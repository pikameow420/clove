import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { env } from "../env";
import { PrismaClient } from "../../generated/prisma/client";
import { logger } from "../logger";

function createPgPool(): Pool {
  const isSupabase = env.DATABASE_URL.includes("supabase.co");
  if (!isSupabase) {
    return new Pool({ connectionString: env.DATABASE_URL });
  }

  // pg v8 treats sslmode=require as verify-full, which rejects Supabase's cert chain.
  const connectionString = env.DATABASE_URL.replace(/\?.*$/, "");
  return new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });
}

const pool = createPgPool();

const adapter = new PrismaPg(pool);
export const prisma = new PrismaClient({ adapter });

export async function connectDb(): Promise<void> {
  await prisma.$connect();
  logger.info("Connected to Postgres");
}

export async function disconnectDb(): Promise<void> {
  await prisma.$disconnect();
  logger.info("Disconnected from Postgres");
}
