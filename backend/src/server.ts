import "dotenv/config";
import { buildApp } from "./app";
import { connectDb, disconnectDb } from "./lib/db/prisma";
import { env } from "./lib/env";
import { logger } from "./lib/logger";

async function start() {
  await connectDb();
  const app = buildApp();

  const shutdown = async () => {
    logger.info("Shutting down");
    await app.close();
    await disconnectDb();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await app.listen({ host: env.HOST, port: env.PORT });
  logger.info({ port: env.PORT, host: env.HOST }, "Server listening");
}

start().catch(async (error) => {
  logger.error({ err: error }, "Failed to start server");
  await disconnectDb();
  process.exit(1);
});
