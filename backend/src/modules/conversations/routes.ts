import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/db/prisma";
import { env } from "../../lib/env";
import { notifyAssistantReply } from "../../lib/push/expo-push";
import { parsePositiveInt } from "../../lib/pagination";
import { logger } from "../../lib/logger";
import { generateCharacterReply, generateCharacterReplyStream } from "../llm/chat-service";
import {
  serializeMessagesWithAttachments,
  type MessageWithAttachments
} from "../images/attachment-serializer";
import { attachAssistantMessageToRequest, planImageReply, type ImageReplyPlan } from "../images/image-reply-service";
import { applyIntimacyEvents, type IntimacyEventInput } from "../intimacy/scoring";
import { serializeIntimacy, type IntimacySnapshot } from "../intimacy/serializer";
import { persistAssistantMessage, recordUserMessage } from "./assistant-message";
import { assertConversationOwnership, getOrCreateConversation } from "./service";

/**
 * Annotates message content with photo markers so the LLM can refer to
 * previously sent pictures without seeing signed URLs or internal prompts.
 */
function withPhotoMarkers(messages: MessageWithAttachments[]): MessageWithAttachments[] {
  return messages.map((message) => {
    if (message.attachments.length === 0 || message.mediaStatus !== "ready") {
      return message;
    }
    const descriptions = message.attachments
      .map((attachment) => {
        const metadata = attachment.metadata as Record<string, unknown> | null;
        const description = metadata && typeof metadata.description === "string" ? metadata.description : null;
        return description ? `[you sent a photo: ${description}]` : "[you sent a photo]";
      })
      .join(" ");
    return { ...message, content: `${message.content}\n${descriptions}` };
  });
}

function imageResponseMeta(plan: ImageReplyPlan): { mediaStatus: string; imageRequestId: string | null } {
  switch (plan.type) {
    case "none":
    case "rejected":
    case "quota_exceeded":
      return { mediaStatus: "none", imageRequestId: null };
    case "cache_hit":
      return { mediaStatus: "ready", imageRequestId: null };
    case "generate":
      return { mediaStatus: "pending", imageRequestId: plan.imageRequestId };
    default: {
      const exhaustive: never = plan;
      throw new Error(`Unhandled image plan: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function mergeIntimacy(...snapshots: IntimacySnapshot[]): IntimacySnapshot {
  const latest = snapshots[snapshots.length - 1] ?? serializeIntimacy({});
  return {
    ...latest,
    leveledUp: snapshots.some((snapshot) => snapshot.leveledUp)
  };
}

function photoIntimacyEvents(plan: ImageReplyPlan, userMessageId: string): IntimacyEventInput[] {
  switch (plan.type) {
    case "cache_hit":
      return [
        { eventType: "photo_request_accepted", sourceId: userMessageId },
        // assistant message id is unknown until persist; cache moment added after persist
      ];
    case "generate":
      return [{ eventType: "photo_request_accepted", sourceId: userMessageId }];
    case "none":
    case "rejected":
    case "quota_exceeded":
      return [];
    default: {
      const exhaustive: never = plan;
      throw new Error(`Unhandled image plan: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** Enough to fill a phone screen with headroom; older pages load on scroll. */
const DEFAULT_MESSAGE_PAGE_SIZE = 30;
const MAX_MESSAGE_PAGE_SIZE = 200;

const conversationByCharacterBody = z.object({
  characterId: z.string().min(1)
});

const messageBodySchema = z.object({
  content: z.string().min(1).max(env.MAX_INPUT_CHARS)
});

export const conversationRoutes: FastifyPluginAsync = async (app) => {
  app.get("/conversations", async (request) => {
    const likes = await prisma.swipe.findMany({
      where: {
        userId: request.user.id,
        decision: "liked"
      },
      include: {
        character: true
      },
      orderBy: {
        updatedAt: "desc"
      }
    });

    const conversations = await prisma.conversation.findMany({
      where: {
        userId: request.user.id,
        characterId: { in: likes.map((swipe) => swipe.characterId) }
      }
    });

    const conversationByCharacterId = new Map(
      conversations.map((conversation) => [conversation.characterId, conversation])
    );

    const conversationIds = conversations.map((conversation) => conversation.id);

    const latestMessages =
      conversationIds.length > 0
        ? await prisma.message.findMany({
            where: { conversationId: { in: conversationIds } },
            orderBy: [{ conversationId: "asc" }, { createdAt: "desc" }],
            distinct: ["conversationId"],
            select: {
              conversationId: true,
              content: true,
              createdAt: true,
              mediaStatus: true
            }
          })
        : [];

    const latestByConversation = new Map(
      latestMessages.map((message) => {
        const hasImage = message.mediaStatus === "ready" || message.mediaStatus === "pending";
        return [
          message.conversationId,
          {
            preview: hasImage ? "Photo" : message.content,
            at: message.createdAt.toISOString(),
            hasImage
          }
        ];
      })
    );

    // Counted in the database rather than by loading every assistant message the
    // user has ever received. Each branch of the OR is a range scan on
    // Message(conversationId, createdAt), so the cost tracks unread volume
    // instead of total history.
    const unreadByConversation = new Map<string, number>();
    if (conversations.length > 0) {
      const unread = await prisma.message.groupBy({
        by: ["conversationId"],
        where: {
          role: "assistant",
          OR: conversations.map((conversation) =>
            conversation.lastReadAt
              ? { conversationId: conversation.id, createdAt: { gt: conversation.lastReadAt } }
              : { conversationId: conversation.id }
          )
        },
        _count: { _all: true }
      });

      for (const row of unread) {
        unreadByConversation.set(row.conversationId, row._count._all);
      }
    }

    const items = likes.map((swipe) => {
      const conversation = conversationByCharacterId.get(swipe.characterId);
      const latest = conversation ? latestByConversation.get(conversation.id) : undefined;
      const intimacy = serializeIntimacy({
        intimacyLevel: conversation?.intimacyLevel,
        intimacyScore: conversation?.intimacyScore
      });
      return {
        conversationId: conversation?.id ?? null,
        character: swipe.character,
        lastMessageAt:
          latest?.at ?? conversation?.lastMessageAt?.toISOString() ?? null,
        lastMessagePreview: latest?.preview ?? null,
        hasImage: latest?.hasImage ?? false,
        matchedAt: swipe.updatedAt,
        unreadCount: conversation ? (unreadByConversation.get(conversation.id) ?? 0) : 0,
        intimacyLevel: intimacy.intimacyLevel,
        intimacyScore: intimacy.intimacyScore,
        intimacyProgress: intimacy.intimacyProgress
      };
    });

    return { items };
  });

  app.post("/conversations/by-character", async (request, reply) => {
    const parsed = conversationByCharacterBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    try {
      const conversation = await getOrCreateConversation(request.user.id, parsed.data.characterId);
      const intimacy = serializeIntimacy(conversation);
      return { conversation, ...intimacy };
    } catch {
      return reply.forbidden("Character must be liked before chat");
    }
  });

  /**
   * Returns the newest page of a thread and walks backwards from there.
   *
   * `before` takes a message id and yields the messages immediately older than
   * it. `items` always comes back oldest-first so the client can append it
   * straight onto the top of the list.
   */
  app.get("/conversations/:id/messages", async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as Record<string, unknown>;
    const limit = parsePositiveInt(query.limit, DEFAULT_MESSAGE_PAGE_SIZE, MAX_MESSAGE_PAGE_SIZE);
    const before = typeof query.before === "string" ? query.before : undefined;

    let conversation;
    try {
      conversation = await assertConversationOwnership(id, request.user.id);
    } catch {
      return reply.notFound("Conversation not found");
    }

    const newestFirst = await prisma.message.findMany({
      where: { conversationId: id },
      // createdAt alone is not deterministic: a user turn and its reply can land
      // in the same millisecond, which would make cursor paging skip or repeat.
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      include: { attachments: true },
      ...(before ? { cursor: { id: before }, skip: 1 } : {})
    });

    const hasNextPage = newestFirst.length > limit;
    const page = hasNextPage ? newestFirst.slice(0, limit) : newestFirst;
    // The cursor is the oldest row handed out, which is where the next (older)
    // page picks up.
    const nextCursor = hasNextPage ? (page[page.length - 1]?.id ?? null) : null;
    const ordered = [...page].reverse();

    // Only the first page represents "the user is looking at the latest
    // messages". Paging into history is not a read, and neither is the 3s poll
    // that runs while a photo generates, which used to write on every tick.
    const newest = ordered[ordered.length - 1];
    if (!before && newest && (!conversation.lastReadAt || newest.createdAt > conversation.lastReadAt)) {
      conversation = await prisma.conversation.update({
        where: { id },
        data: { lastReadAt: new Date() }
      });
    }

    const items = await serializeMessagesWithAttachments(ordered);

    return {
      items,
      pageInfo: { hasNextPage, nextCursor },
      intimacy: serializeIntimacy(conversation)
    };
  });

  app.post("/conversations/:id/messages", async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as Record<string, unknown>;
    const stream = query.stream !== "false";

    const parsedBody = messageBodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({ error: parsedBody.error.flatten() });
    }

    let conversation;
    try {
      conversation = await assertConversationOwnership(id, request.user.id);
    } catch {
      return reply.notFound("Conversation not found");
    }

    const character = await prisma.character.findUnique({ where: { id: conversation.characterId } });
    if (!character || !character.isActive) {
      return reply.notFound("Character no longer available");
    }

    const recentMessages = await prisma.message.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: "asc" },
      take: env.MAX_CONTEXT_MESSAGES,
      include: { attachments: true }
    });

    const previousAssistant = [...recentMessages].reverse().find((message) => message.role === "assistant");

    const userTurn = await recordUserMessage({
      conversationId: conversation.id,
      content: parsedBody.data.content,
      previousAssistantContent: previousAssistant?.content
    });
    const userMessage = userTurn.message;

    const imagePlan = await planImageReply({
      character,
      userId: request.user.id,
      conversationId: conversation.id,
      userMessageId: userMessage.id,
      userInput: parsedBody.data.content,
      recentMessages,
      summary: conversation.summary
    });

    const extraSystemInstruction =
      imagePlan.type === "none" || !imagePlan.instruction ? undefined : imagePlan.instruction;
    const llmHistory = withPhotoMarkers(recentMessages);
    const intimacyLevelForPrompt = userTurn.intimacy.intimacyLevel;

    const pushAssistantReply = (replyContent: string) => {
      void notifyAssistantReply({
        userId: request.user.id,
        characterId: character.id,
        characterName: character.name,
        conversationId: conversation.id,
        replyContent
      });
    };

    const finalizeAssistantMessage = async (content: string, tokenCount: number | null) => {
      const intimacyEvents = photoIntimacyEvents(imagePlan, userMessage.id);

      const persisted = await persistAssistantMessage({
        conversationId: conversation.id,
        userId: request.user.id,
        characterId: character.id,
        characterName: character.name,
        content,
        tokenCount,
        source: "assistant_reply",
        mediaStatus:
          imagePlan.type === "cache_hit" ? "ready" : imagePlan.type === "generate" ? "pending" : "none",
        attachment:
          imagePlan.type === "cache_hit"
            ? {
                storagePath: imagePlan.asset.storagePath,
                mimeType: imagePlan.asset.mimeType,
                assetId: imagePlan.asset.id,
                metadata: { description: imagePlan.asset.description ?? imagePlan.brief.scene }
              }
            : undefined,
        recentMessages: [...recentMessages, userMessage],
        existingSummary: conversation.summary,
        latestUserInput: parsedBody.data.content,
        latestAssistantReply: content,
        // Pushed manually after the response is flushed, so the notification
        // never reaches the device before the reply is visible in the app.
        sendPush: false,
        intimacyEvents
      });

      let intimacy = persisted.intimacy;
      if (imagePlan.type === "cache_hit") {
        intimacy = await applyIntimacyEvents({
          conversationId: conversation.id,
          events: [{ eventType: "photo_moment_cache", sourceId: persisted.message.id }]
        });
      }

      if (imagePlan.type === "generate") {
        await attachAssistantMessageToRequest(imagePlan.imageRequestId, persisted.message.id);
      }

      const withAttachments = await prisma.message.findUniqueOrThrow({
        where: { id: persisted.message.id },
        include: { attachments: true }
      });
      const [serialized] = await serializeMessagesWithAttachments([withAttachments]);
      return {
        assistantMessage: serialized!,
        intimacy: mergeIntimacy(userTurn.intimacy, persisted.intimacy, intimacy)
      };
    };

    if (!stream) {
      const startedAt = Date.now();
      const assistant = await generateCharacterReply({
        character,
        summary: conversation.summary,
        recentMessages: llmHistory,
        userInput: parsedBody.data.content,
        extraSystemInstruction,
        intimacyLevel: intimacyLevelForPrompt
      });
      const latencyMs = Date.now() - startedAt;

      const finalized = await finalizeAssistantMessage(assistant.content, assistant.tokenCount);

      logger.info(
        {
          userId: request.user.id,
          conversationId: conversation.id,
          latencyMs,
          tokenCount: assistant.tokenCount,
          imagePlan: imagePlan.type,
          intimacyLevel: finalized.intimacy.intimacyLevel
        },
        "Generated assistant response"
      );

      reply.send({
        userMessage,
        assistantMessage: finalized.assistantMessage,
        ...imageResponseMeta(imagePlan),
        ...finalized.intimacy
      });
      pushAssistantReply(assistant.content);
      return reply;
    }

    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.flushHeaders();

    let fullContent = "";
    const startedAt = Date.now();

    try {
      const assistant = await generateCharacterReplyStream(
        {
          character,
          summary: conversation.summary,
          recentMessages: llmHistory,
          userInput: parsedBody.data.content,
          extraSystemInstruction,
          intimacyLevel: intimacyLevelForPrompt
        },
        (token) => {
          fullContent += token;
          reply.raw.write(`event: token\ndata: ${JSON.stringify({ token })}\n\n`);
        }
      );

      const storedContent = fullContent || assistant.content;
      const finalized = await finalizeAssistantMessage(storedContent, assistant.tokenCount);

      const latencyMs = Date.now() - startedAt;
      logger.info(
        {
          userId: request.user.id,
          conversationId: conversation.id,
          latencyMs,
          tokenCount: assistant.tokenCount,
          imagePlan: imagePlan.type,
          intimacyLevel: finalized.intimacy.intimacyLevel
        },
        "Streamed assistant response"
      );

      reply.raw.write(
        `event: done\ndata: ${JSON.stringify({
          tokenCount: assistant.tokenCount,
          assistantMessage: finalized.assistantMessage,
          ...imageResponseMeta(imagePlan),
          ...finalized.intimacy
        })}\n\n`
      );
      reply.raw.end();
      pushAssistantReply(storedContent);
      return reply;
    } catch (error) {
      logger.error({ err: error, conversationId: conversation.id }, "Failed streaming response");
      reply.raw.write(
        `event: error\ndata: ${JSON.stringify({ message: "Failed to generate assistant response", partial: fullContent })}\n\n`
      );
      reply.raw.end();
      return reply;
    }
  });
};
