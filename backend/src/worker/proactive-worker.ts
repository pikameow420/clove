import "dotenv/config";
import { connectDb, disconnectDb } from "../lib/db/prisma";
import { env } from "../lib/env";
import { logger } from "../lib/logger";
import { runProactiveTick } from "../modules/proactive/tick";

async function main(): Promise<void> {
  await connectDb();
  logger.info({ tickMs: env.PROACTIVE_TICK_MS }, "Proactive worker started");

  const tick = async () => {
    try {
      await runProactiveTick();
    } catch (error) {
      logger.error({ err: error }, "Proactive tick failed");
    }
  };

  await tick();
  const interval = setInterval(tick, env.PROACTIVE_TICK_MS);

  const shutdown = async () => {
    clearInterval(interval);
    await disconnectDb();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch(async (error) => {
  logger.error({ err: error }, "Proactive worker failed to start");
  await disconnectDb();
  process.exit(1);
});
