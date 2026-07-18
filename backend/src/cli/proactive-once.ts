import "dotenv/config";
import { connectDb, disconnectDb } from "../lib/db/prisma";
import { runProactiveTick } from "../modules/proactive/tick";

function parseArgs(argv: string[]): { dryRun: boolean } {
  return { dryRun: argv.includes("--dry-run") };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await connectDb();

  try {
    await runProactiveTick({ dryRun: args.dryRun });
  } finally {
    await disconnectDb();
  }
}

main().catch(async (error) => {
  console.error("Proactive once failed:", error instanceof Error ? error.message : error);
  await disconnectDb().catch(() => undefined);
  process.exit(1);
});
