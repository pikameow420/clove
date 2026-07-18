import { Prisma } from "../../generated/prisma/client";
import type { Character, Message } from "../../generated/prisma/client";
import { prisma } from "../../lib/db/prisma";
import { env } from "../../lib/env";
import { logger } from "../../lib/logger";
import { findCachedAsset, recordCacheUse } from "./image-cache";
import {
  buildAcceptedCaptionInstruction,
  buildRejectionInstruction,
  classifyImageIntent,
  type ImageBrief,
  type RejectionReason,
} from "./image-intent";

export type ImageReplyPlan =
  | { type: "none" }
  | { type: "rejected"; reason: RejectionReason; instruction: string }
  | { type: "quota_exceeded"; instruction: string }
  | {
      type: "cache_hit";
      instruction: string;
      brief: ImageBrief;
      asset: { id: string; storagePath: string; mimeType: string; description: string | null };
    }
  | { type: "generate"; instruction: string; brief: ImageBrief; imageRequestId: string };

const QUOTA_EXCEEDED_INSTRUCTION =
  "The user asked for a photo. You cannot send one right now (you are busy). Tease that you will send one later, in one or two short lines. Do not send or promise an immediate photo. Do not mention rules, limits, or being an AI.";

const NO_REFERENCE_INSTRUCTION =
  "The user asked for a photo but you cannot send one right now. Playfully deflect in one or two short lines without promising a photo. Do not mention rules or being an AI.";

export async function countGenerationsLast24h(userId: string, now = new Date()): Promise<number> {
  const windowStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return prisma.imageGenerationRequest.count({
    where: {
      userId,
      generationReservedAt: { gte: windowStart },
    },
  });
}

export async function getImageUsage(userId: string): Promise<{
  generatedLast24h: number;
  limit: number;
  remaining: number;
  resetAt: string | null;
}> {
  const now = new Date();
  const windowStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const requests = await prisma.imageGenerationRequest.findMany({
    where: { userId, generationReservedAt: { gte: windowStart } },
    orderBy: { generationReservedAt: "asc" },
    select: { generationReservedAt: true },
  });

  const generatedLast24h = requests.length;
  const remaining = Math.max(0, env.IMAGE_DAILY_GENERATION_LIMIT - generatedLast24h);
  const oldest = requests[0]?.generationReservedAt ?? null;
  const resetAt = oldest ? new Date(oldest.getTime() + 24 * 60 * 60 * 1000).toISOString() : null;

  return { generatedLast24h, limit: env.IMAGE_DAILY_GENERATION_LIMIT, remaining, resetAt };
}

/**
 * Atomically reserves one generation slot and creates the queued request.
 * Serializable isolation prevents concurrent requests from exceeding quota.
 */
async function reserveGeneration(params: {
  userId: string;
  conversationId: string;
  characterId: string;
  userMessageId: string;
  brief: ImageBrief;
}): Promise<{ reserved: true; requestId: string } | { reserved: false }> {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await prisma.$transaction(
        async (tx) => {
          const now = new Date();
          const windowStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
          const used = await tx.imageGenerationRequest.count({
            where: { userId: params.userId, generationReservedAt: { gte: windowStart } },
          });

          if (used >= env.IMAGE_DAILY_GENERATION_LIMIT) {
            return { reserved: false as const };
          }

          const request = await tx.imageGenerationRequest.create({
            data: {
              userId: params.userId,
              conversationId: params.conversationId,
              characterId: params.characterId,
              userMessageId: params.userMessageId,
              status: "queued",
              decisionReason: "accepted",
              brief: params.brief as unknown as Prisma.InputJsonValue,
              generationReservedAt: now,
            },
          });

          return { reserved: true as const, requestId: request.id };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );
      return result;
    } catch (error) {
      const isSerializationConflict =
        error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034";
      if (!isSerializationConflict || attempt === maxAttempts) {
        throw error;
      }
    }
  }
  return { reserved: false };
}

/**
 * Decides how the chat turn should handle a potential image request: no image
 * involvement, an in-character refusal, an immediate cache hit, or a queued
 * generation that already reserved quota.
 */
export async function planImageReply(params: {
  character: Character;
  userId: string;
  conversationId: string;
  userMessageId: string;
  userInput: string;
  recentMessages: Message[];
  summary: string | null;
}): Promise<ImageReplyPlan> {
  if (!env.IMAGE_REPLIES_ENABLED) {
    return { type: "none" };
  }

  // Idempotency: one image request per user message.
  const existing = await prisma.imageGenerationRequest.findUnique({
    where: { userMessageId: params.userMessageId },
    select: { id: true },
  });
  if (existing) {
    return { type: "none" };
  }

  let decision;
  try {
    decision = await classifyImageIntent({
      character: params.character,
      userInput: params.userInput,
      recentMessages: params.recentMessages,
      summary: params.summary,
    });
  } catch (error) {
    logger.warn({ err: error, conversationId: params.conversationId }, "Image intent classification failed");
    return { type: "none" };
  }

  if (decision.kind === "not_image_request") {
    return { type: "none" };
  }

  if (decision.kind === "rejected") {
    logger.info(
      { conversationId: params.conversationId, decisionReason: decision.reason },
      "Image request rejected"
    );
    return {
      type: "rejected",
      reason: decision.reason,
      instruction: buildRejectionInstruction(decision.reason),
    };
  }

  const brief = decision.brief;

  const cached = await findCachedAsset({ characterId: params.character.id, brief });
  if (cached) {
    await recordCacheUse(cached.id);
    logger.info(
      { conversationId: params.conversationId, assetId: cached.id, sceneKey: brief.sceneKey },
      "Image cache hit"
    );
    return {
      type: "cache_hit",
      instruction: buildAcceptedCaptionInstruction(brief),
      brief,
      asset: {
        id: cached.id,
        storagePath: cached.storagePath,
        mimeType: cached.mimeType,
        description: cached.description,
      },
    };
  }

  const referenceCount = await prisma.characterImageAsset.count({
    where: { characterId: params.character.id, kind: "reference", isActive: true },
  });
  if (referenceCount === 0) {
    logger.info(
      { conversationId: params.conversationId, characterId: params.character.id },
      "Image generation skipped: no active reference assets"
    );
    return { type: "rejected", reason: "unsafe_other", instruction: NO_REFERENCE_INSTRUCTION };
  }

  const reservation = await reserveGeneration({
    userId: params.userId,
    conversationId: params.conversationId,
    characterId: params.character.id,
    userMessageId: params.userMessageId,
    brief,
  });

  if (!reservation.reserved) {
    logger.info({ conversationId: params.conversationId, userId: params.userId }, "Image quota exceeded");
    return { type: "quota_exceeded", instruction: QUOTA_EXCEEDED_INSTRUCTION };
  }

  logger.info(
    {
      conversationId: params.conversationId,
      imageRequestId: reservation.requestId,
      sceneKey: brief.sceneKey,
    },
    "Image generation reserved"
  );

  return {
    type: "generate",
    instruction: buildAcceptedCaptionInstruction(brief),
    brief,
    imageRequestId: reservation.requestId,
  };
}

/** Links the queued request to the persisted assistant (caption) message. */
export async function attachAssistantMessageToRequest(
  imageRequestId: string,
  assistantMessageId: string
): Promise<void> {
  await prisma.imageGenerationRequest.update({
    where: { id: imageRequestId },
    data: { assistantMessageId },
  });
}
