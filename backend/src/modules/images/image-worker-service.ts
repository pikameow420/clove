import { randomUUID } from "node:crypto";
import { Prisma } from "../../generated/prisma/client";
import type { Character, ImageGenerationRequest } from "../../generated/prisma/client";
import { prisma } from "../../lib/db/prisma";
import { env } from "../../lib/env";
import { logger } from "../../lib/logger";
import {
  generateCharacterImage,
  ImageGenerationRetryableError,
  ImageModerationBlockedError,
} from "../../lib/openai/image-client";
import { notifyAssistantReply } from "../../lib/push/expo-push";
import { downloadImage, generatedStoragePath, uploadImage } from "../../lib/storage/supabase-storage";
import { demoteExcessCacheAssets } from "./image-cache";
import { imageBriefSchema, type ImageBrief } from "./image-intent";

const MIN_IMAGE_BYTES = 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * Claims one queued request (or one whose processing lease expired) using an
 * optimistic guarded update so concurrent workers never process the same job.
 */
export async function claimNextImageRequest(): Promise<ImageGenerationRequest | null> {
  const now = new Date();
  const leasedUntil = new Date(now.getTime() + env.IMAGE_WORKER_LEASE_MS);

  const candidates = await prisma.imageGenerationRequest.findMany({
    where: {
      OR: [
        { status: "queued" },
        { status: "processing", leasedUntil: { lt: now } },
      ],
    },
    orderBy: { createdAt: "asc" },
    take: 5,
    select: { id: true, status: true, leasedUntil: true },
  });

  for (const candidate of candidates) {
    const claimed = await prisma.imageGenerationRequest.updateMany({
      where: {
        id: candidate.id,
        status: candidate.status,
        leasedUntil: candidate.leasedUntil,
      },
      data: {
        status: "processing",
        leasedUntil,
        attemptCount: { increment: 1 },
      },
    });

    if (claimed.count === 1) {
      return prisma.imageGenerationRequest.findUniqueOrThrow({ where: { id: candidate.id } });
    }
  }

  return null;
}

function buildImagePrompt(character: Character, brief: ImageBrief): string {
  const profile = character.profile as Record<string, unknown> | null;
  const appearance =
    profile && typeof profile.appearance === "string" && profile.appearance.trim()
      ? profile.appearance
      : null;

  return [
    `A realistic, candid photo of ${character.name}, the exact person shown in the reference images.`,
    "Keep their face, hair, body, and overall identity consistent with the references.",
    appearance ? `Appearance notes: ${appearance}` : "",
    `Scene: ${brief.scene}.`,
    `Setting: ${brief.setting}.`,
    `Wardrobe: ${brief.wardrobe}.`,
    `Pose: ${brief.pose}.`,
    `Mood: ${brief.mood}.`,
    `Camera: ${brief.camera}.`,
    "The photo should look like it was taken on a smartphone and sent in a chat: natural lighting, believable detail, no watermarks, no text overlays.",
  ]
    .filter(Boolean)
    .join(" ");
}

async function markTerminalFailure(
  request: ImageGenerationRequest,
  status: "rejected" | "failed",
  errorCode: string
): Promise<void> {
  await prisma.$transaction([
    prisma.imageGenerationRequest.update({
      where: { id: request.id },
      data: { status, errorCode, leasedUntil: null },
    }),
    ...(request.assistantMessageId
      ? [
          prisma.message.update({
            where: { id: request.assistantMessageId },
            data: { mediaStatus: status },
          }),
        ]
      : []),
  ]);
  logger.warn({ imageRequestId: request.id, status, errorCode }, "Image request terminally failed");
}

async function requeueForRetry(request: ImageGenerationRequest, errorCode: string): Promise<void> {
  await prisma.imageGenerationRequest.update({
    where: { id: request.id },
    data: { status: "queued", leasedUntil: null, errorCode },
  });
  logger.info(
    { imageRequestId: request.id, attemptCount: request.attemptCount, errorCode },
    "Image request requeued for retry"
  );
}

/** Bounded exponential backoff between retry attempts for transient failures. */
function retryDelayMs(attemptCount: number): number {
  return Math.min(60_000, 2 ** attemptCount * 1_000);
}

export async function processImageRequest(request: ImageGenerationRequest): Promise<void> {
  const startedAt = Date.now();

  const briefResult = imageBriefSchema.safeParse(request.brief);
  if (!briefResult.success) {
    await markTerminalFailure(request, "failed", "invalid_brief");
    return;
  }
  const brief = briefResult.data;

  const character = await prisma.character.findUnique({ where: { id: request.characterId } });
  if (!character) {
    await markTerminalFailure(request, "failed", "character_missing");
    return;
  }

  const references = await prisma.characterImageAsset.findMany({
    where: { characterId: request.characterId, kind: "reference", isActive: true },
    orderBy: { createdAt: "asc" },
    take: 5,
  });
  if (references.length === 0) {
    await markTerminalFailure(request, "failed", "no_reference_assets");
    return;
  }

  let generated;
  try {
    const referenceInputs = await Promise.all(
      references.map(async (reference, index) => ({
        buffer: await downloadImage(reference.storagePath),
        mimeType: reference.mimeType,
        fileName: `reference-${index}.${reference.mimeType.split("/")[1] ?? "png"}`,
      }))
    );

    generated = await generateCharacterImage({
      references: referenceInputs,
      prompt: buildImagePrompt(character, brief),
    });
  } catch (error) {
    if (error instanceof ImageModerationBlockedError) {
      logger.warn({ imageRequestId: request.id }, "OpenAI moderation blocked generation");
      await markTerminalFailure(request, "rejected", "moderation_blocked");
      return;
    }

    const retryable = error instanceof ImageGenerationRetryableError;
    if (retryable && request.attemptCount < env.IMAGE_WORKER_MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs(request.attemptCount)));
      await requeueForRetry(request, "transient_generation_error");
      return;
    }

    logger.error({ err: error, imageRequestId: request.id }, "Image generation failed");
    await markTerminalFailure(request, "failed", retryable ? "retries_exhausted" : "generation_error");
    return;
  }

  if (generated.buffer.length < MIN_IMAGE_BYTES || generated.buffer.length > MAX_IMAGE_BYTES) {
    await markTerminalFailure(request, "failed", "invalid_image_bytes");
    return;
  }

  const assetId = randomUUID();
  const storagePath = generatedStoragePath(request.characterId, assetId);

  try {
    await uploadImage({ path: storagePath, buffer: generated.buffer, mimeType: generated.mimeType });
  } catch (error) {
    if (request.attemptCount < env.IMAGE_WORKER_MAX_ATTEMPTS) {
      await requeueForRetry(request, "storage_upload_error");
    } else {
      logger.error({ err: error, imageRequestId: request.id }, "Storage upload failed");
      await markTerminalFailure(request, "failed", "storage_upload_error");
    }
    return;
  }

  const now = new Date();
  await prisma.$transaction([
    prisma.characterImageAsset.create({
      data: {
        id: assetId,
        characterId: request.characterId,
        kind: "generated",
        storagePath,
        mimeType: generated.mimeType,
        sceneKey: brief.sceneKey,
        tags: brief.tags as unknown as Prisma.InputJsonValue,
        description: brief.scene,
        isReusable: true,
        lastUsedAt: now,
        useCount: 1,
      },
    }),
    ...(request.assistantMessageId
      ? [
          prisma.messageAttachment.create({
            data: {
              messageId: request.assistantMessageId,
              type: "image",
              storagePath,
              mimeType: generated.mimeType,
              assetId,
              metadata: { description: brief.scene },
            },
          }),
          prisma.message.update({
            where: { id: request.assistantMessageId },
            data: { mediaStatus: "ready" },
          }),
        ]
      : []),
    prisma.imageGenerationRequest.update({
      where: { id: request.id },
      data: { status: "ready", assetId, leasedUntil: null, errorCode: null },
    }),
  ]);

  await demoteExcessCacheAssets(request.characterId);

  void notifyAssistantReply({
    userId: request.userId,
    characterId: request.characterId,
    characterName: character.name,
    conversationId: request.conversationId,
    replyContent: "Sent you a photo",
  });

  logger.info(
    {
      imageRequestId: request.id,
      assetId,
      characterId: request.characterId,
      latencyMs: Date.now() - startedAt,
    },
    "Image request completed"
  );
}

/** Runs one worker iteration; returns true when a job was processed. */
export async function runImageWorkerOnce(): Promise<boolean> {
  const request = await claimNextImageRequest();
  if (!request) {
    return false;
  }

  try {
    await processImageRequest(request);
  } catch (error) {
    logger.error({ err: error, imageRequestId: request.id }, "Unhandled image worker error");
    await markTerminalFailure(request, "failed", "worker_error").catch(() => undefined);
  }

  return true;
}
