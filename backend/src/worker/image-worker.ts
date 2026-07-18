import "dotenv/config";
import { connectDb, disconnectDb } from "../lib/db/prisma";
import { env } from "../lib/env";
import { logger } from "../lib/logger";
import { runImageWorkerOnce } from "../modules/images/image-worker-service";

let running = true;

async function main(): Promise<void> {
  await connectDb();
  logger.info(
    { pollMs: env.IMAGE_WORKER_POLL_MS, model: env.OPENAI_IMAGE_MODEL },
    "Image worker started"
  );

  while (running) {
    let processed = false;
    try {
      processed = await runImageWorkerOnce();
    } catch (error) {
      logger.error({ err: error }, "Image worker iteration failed");
    }

    if (!processed && running) {
      await new Promise((resolve) => setTimeout(resolve, env.IMAGE_WORKER_POLL_MS));
    }
  }

  await disconnectDb();
  process.exit(0);
}

const shutdown = () => {
  logger.info("Image worker shutting down");
  running = false;
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch(async (error) => {
  logger.error({ err: error }, "Image worker failed to start");
  await disconnectDb();
  process.exit(1);
});
