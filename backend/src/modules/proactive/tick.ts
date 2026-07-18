import { logger } from "../../lib/logger";
import { dryRunProactiveTick, findProactiveCandidatesForTick, sendProactiveMessage } from "./eligibility";

export async function runProactiveTick(options: { dryRun?: boolean } = {}): Promise<void> {
  const now = new Date();

  if (options.dryRun) {
    const preview = await dryRunProactiveTick(now);
    logger.info({ count: preview.length, preview }, "Proactive tick dry run");
    return;
  }

  const candidates = await findProactiveCandidatesForTick(now);
  if (!candidates.length) {
    logger.info("Proactive tick: no eligible candidates");
    return;
  }

  logger.info({ count: candidates.length }, "Proactive tick: processing candidates");

  for (const candidate of candidates) {
    try {
      const message = await sendProactiveMessage(candidate);
      logger.info(
        {
          userId: candidate.userId,
          characterId: candidate.characterId,
          conversationId: message.conversationId,
          trigger: candidate.trigger,
          messageId: message.id
        },
        "Proactive message sent"
      );
    } catch (error) {
      logger.error(
        {
          err: error,
          userId: candidate.userId,
          characterId: candidate.characterId,
          trigger: candidate.trigger
        },
        "Failed to send proactive message"
      );
    }
  }
}
