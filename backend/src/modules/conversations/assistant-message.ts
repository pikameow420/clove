import type { MediaStatus, Message, MessageSource, ProactiveTrigger } from "../../generated/prisma/client";
import { prisma } from "../../lib/db/prisma";
import { env } from "../../lib/env";
import { notifyAssistantReply } from "../../lib/push/expo-push";
import { refreshConversationMemory } from "./memory";

type AttachmentInput = {
  storagePath: string;
  mimeType: string;
  assetId?: string;
  width?: number;
  height?: number;
  metadata?: Record<string, unknown>;
};

type PersistAssistantMessageArgs = {
  conversationId: string;
  userId: string;
  characterId: string;
  characterName: string;
  content: string;
  tokenCount: number | null;
  source: MessageSource;
  proactiveTrigger?: ProactiveTrigger;
  mediaStatus?: MediaStatus;
  attachment?: AttachmentInput;
  recentMessages: Message[];
  existingSummary: string | null;
  latestUserInput?: string;
  latestAssistantReply: string;
  sendPush?: boolean;
};

export async function persistAssistantMessage(args: PersistAssistantMessageArgs): Promise<Message> {
  const assistantMessage = await prisma.message.create({
    data: {
      conversationId: args.conversationId,
      role: "assistant",
      content: args.content,
      tokenCount: args.tokenCount ?? undefined,
      source: args.source,
      proactiveTrigger: args.proactiveTrigger,
      mediaStatus: args.mediaStatus ?? "none",
      ...(args.attachment
        ? {
            attachments: {
              create: {
                type: "image" as const,
                storagePath: args.attachment.storagePath,
                mimeType: args.attachment.mimeType,
                assetId: args.attachment.assetId,
                width: args.attachment.width,
                height: args.attachment.height,
                metadata: (args.attachment.metadata ?? {}) as object
              }
            }
          }
        : {})
    }
  });

  const nextSummary = await refreshConversationMemory({
    characterName: args.characterName,
    existingSummary: args.existingSummary,
    allMessages: [...args.recentMessages, assistantMessage],
    latestUserInput: args.latestUserInput ?? "",
    latestAssistantReply: args.latestAssistantReply
  });

  const isProactive = args.source === "assistant_proactive";
  const now = assistantMessage.createdAt;

  const conversation = await prisma.conversation.findUniqueOrThrow({
    where: { id: args.conversationId },
    select: { consecutiveProactiveCount: true }
  });

  const nextConsecutiveCount = isProactive ? conversation.consecutiveProactiveCount + 1 : conversation.consecutiveProactiveCount;
  const proactiveBackoffUntil =
    isProactive && nextConsecutiveCount >= 2 ? new Date(now.getTime() + env.PROACTIVE_BACKOFF_MS) : undefined;

  await prisma.conversation.update({
    where: { id: args.conversationId },
    data: {
      lastMessageAt: now,
      summary: nextSummary,
      ...(isProactive
        ? {
            lastProactiveMessageAt: now,
            consecutiveProactiveCount: nextConsecutiveCount,
            proactiveBackoffUntil
          }
        : {})
    }
  });

  if (args.sendPush !== false) {
    void notifyAssistantReply({
      userId: args.userId,
      characterId: args.characterId,
      characterName: args.characterName,
      conversationId: args.conversationId,
      replyContent: args.content
    });
  }

  return assistantMessage;
}

export async function recordUserMessage(params: {
  conversationId: string;
  content: string;
}): Promise<Message> {
  const now = new Date();
  const userMessage = await prisma.message.create({
    data: {
      conversationId: params.conversationId,
      role: "user",
      content: params.content
    }
  });

  await prisma.conversation.update({
    where: { id: params.conversationId },
    data: {
      lastMessageAt: now,
      lastUserMessageAt: now,
      consecutiveProactiveCount: 0,
      proactiveBackoffUntil: null
    }
  });

  return userMessage;
}
