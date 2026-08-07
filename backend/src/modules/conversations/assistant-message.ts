import type { MediaStatus, Message, MessageSource, ProactiveTrigger } from "../../generated/prisma/client";
import type { MessageWithAttachments } from "../images/attachment-serializer";
import { prisma } from "../../lib/db/prisma";
import { env } from "../../lib/env";
import { logger } from "../../lib/logger";
import { notifyAssistantReply } from "../../lib/push/expo-push";
import { applyIntimacyEvents, type IntimacyEventInput } from "../intimacy/scoring";
import { serializeIntimacy, type IntimacySnapshot } from "../intimacy/serializer";
import { buildSharedDayEvent, buildUserMessageIntimacyEvents } from "../intimacy/user-turn";
import {
  previewTextFromContent,
  segmentsToPreviewText,
  type RoleplaySegment
} from "../llm/roleplay";
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
  /** Roleplay narration/dialogue split; null keeps the plain-content rendering. */
  segments?: RoleplaySegment[] | null;
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
  intimacyEvents?: IntimacyEventInput[];
};

export type PersistAssistantMessageResult = {
  message: MessageWithAttachments;
  intimacy: IntimacySnapshot;
};

/**
 * The memory refresh runs a second LLM call roughly every 4 messages and used
 * to block the reply for its full duration (~5s measured). It now runs in the
 * background once the reply is persisted; the summary and warmth points land
 * shortly after. Overlapping refreshes for one conversation are skipped — the
 * next turn re-triggers because the stored summary's messageCount stays stale
 * until a refresh completes.
 */
const memoryRefreshInFlight = new Set<string>();

type ScheduleMemoryRefreshArgs = {
  conversationId: string;
  assistantMessageId: string;
  characterName: string;
  existingSummary: string | null;
  allMessages: Message[];
  latestUserInput: string;
  latestAssistantReply: string;
};

function scheduleMemoryRefresh(args: ScheduleMemoryRefreshArgs): void {
  if (memoryRefreshInFlight.has(args.conversationId)) {
    return;
  }
  memoryRefreshInFlight.add(args.conversationId);

  refreshConversationMemory({
    characterName: args.characterName,
    existingSummary: args.existingSummary,
    allMessages: args.allMessages,
    latestUserInput: args.latestUserInput,
    latestAssistantReply: args.latestAssistantReply
  })
    .then(async (refresh) => {
      if (refresh.summary !== args.existingSummary) {
        await prisma.conversation.update({
          where: { id: args.conversationId },
          data: { summary: refresh.summary }
        });
      }
      if (refresh.warmthPoints !== null) {
        await applyIntimacyEvents({
          conversationId: args.conversationId,
          events: [
            {
              eventType: "memory_warmth",
              sourceId: args.assistantMessageId,
              requestedPoints: refresh.warmthPoints
            }
          ]
        });
      }
    })
    .catch((error) => {
      logger.warn(
        { err: error, conversationId: args.conversationId },
        "Background conversation memory refresh failed"
      );
    })
    .finally(() => {
      memoryRefreshInFlight.delete(args.conversationId);
    });
}

/**
 * Notifications and list previews show one line of text, where a stripped scene
 * description ("*she looks up from her book*") reads as broken markup.
 */
export function assistantPreviewText(
  segments: RoleplaySegment[] | null | undefined,
  content: string
): string {
  return segments ? segmentsToPreviewText(segments) : previewTextFromContent(content);
}

export async function persistAssistantMessage(
  args: PersistAssistantMessageArgs
): Promise<PersistAssistantMessageResult> {
  const assistantMessage = await prisma.message.create({
    data: {
      conversationId: args.conversationId,
      role: "assistant",
      content: args.content,
      segments: args.segments ?? undefined,
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
    },
    include: { attachments: true }
  });

  const isProactive = args.source === "assistant_proactive";
  const now = assistantMessage.createdAt;

  const conversation = await prisma.conversation.findUniqueOrThrow({
    where: { id: args.conversationId },
    select: { consecutiveProactiveCount: true, intimacyLevel: true, intimacyScore: true }
  });

  const nextConsecutiveCount = isProactive
    ? conversation.consecutiveProactiveCount + 1
    : conversation.consecutiveProactiveCount;
  const proactiveBackoffUntil =
    isProactive && nextConsecutiveCount >= 2
      ? new Date(now.getTime() + env.PROACTIVE_BACKOFF_MS)
      : undefined;

  await prisma.conversation.update({
    where: { id: args.conversationId },
    data: {
      lastMessageAt: now,
      ...(isProactive
        ? {
            lastProactiveMessageAt: now,
            consecutiveProactiveCount: nextConsecutiveCount,
            proactiveBackoffUntil
          }
        : {})
    }
  });

  // Off the response path: the reply no longer waits ~5s on the memory LLM
  // call. Summary + warmth apply asynchronously when the refresh resolves.
  scheduleMemoryRefresh({
    conversationId: args.conversationId,
    assistantMessageId: assistantMessage.id,
    characterName: args.characterName,
    existingSummary: args.existingSummary,
    allMessages: [...args.recentMessages, assistantMessage],
    latestUserInput: args.latestUserInput ?? "",
    latestAssistantReply: args.latestAssistantReply
  });

  const intimacyEvents: IntimacyEventInput[] = [...(args.intimacyEvents ?? [])];

  if (isProactive) {
    intimacyEvents.push({
      eventType: "proactive_sent",
      sourceId: assistantMessage.id,
      requestedPoints: 0
    });
  }

  const sharedDay = await buildSharedDayEvent({
    conversationId: args.conversationId,
    now
  });
  if (sharedDay) {
    intimacyEvents.push(sharedDay);
  }

  const intimacy =
    intimacyEvents.length > 0
      ? await applyIntimacyEvents({
          conversationId: args.conversationId,
          events: intimacyEvents,
          now
        })
      : serializeIntimacy(conversation);

  if (args.sendPush !== false) {
    void notifyAssistantReply({
      userId: args.userId,
      characterId: args.characterId,
      characterName: args.characterName,
      conversationId: args.conversationId,
      replyContent: assistantPreviewText(args.segments, args.content)
    });
  }

  return { message: assistantMessage, intimacy };
}

export type RecordUserMessageResult = {
  message: Message;
  intimacy: IntimacySnapshot;
};

export async function recordUserMessage(params: {
  conversationId: string;
  content: string;
  previousAssistantContent?: string | null;
}): Promise<RecordUserMessageResult> {
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

  const events = await buildUserMessageIntimacyEvents({
    conversationId: params.conversationId,
    userMessage,
    previousAssistantContent: params.previousAssistantContent,
    now
  });

  const intimacy = await applyIntimacyEvents({
    conversationId: params.conversationId,
    events,
    now
  });

  return { message: userMessage, intimacy };
}
