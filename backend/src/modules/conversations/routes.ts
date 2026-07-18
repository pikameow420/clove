import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/db/prisma";
import { env } from "../../lib/env";
import { parsePositiveInt } from "../../lib/pagination";
import { logger } from "../../lib/logger";
import { generateCharacterReply, generateCharacterReplyStream } from "../llm/chat-service";
import {
  serializeMessagesWithAttachments,
  type MessageWithAttachments
} from "../images/attachment-serializer";
import { attachAssistantMessageToRequest, planImageReply, type ImageReplyPlan } from "../images/image-reply-service";
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

    const items = likes.map((swipe) => {
      const conversation = conversationByCharacterId.get(swipe.characterId);
      const latest = conversation ? latestByConversation.get(conversation.id) : undefined;
      return {
        conversationId: conversation?.id ?? null,
        character: swipe.character,
        lastMessageAt:
          latest?.at ?? conversation?.lastMessageAt?.toISOString() ?? null,
        lastMessagePreview: latest?.preview ?? null,
        hasImage: latest?.hasImage ?? false,
        matchedAt: swipe.updatedAt
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
      return { conversation };
    } catch {
      return reply.forbidden("Character must be liked before chat");
    }
  });

  app.get("/conversations/:id/messages", async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as Record<string, unknown>;
    const limit = parsePositiveInt(query.limit, 50, 200);
    const cursor = typeof query.cursor === "string" ? query.cursor : undefined;

    try {
      await assertConversationOwnership(id, request.user.id);
    } catch {
      return reply.notFound("Conversation not found");
    }

    const messages = await prisma.message.findMany({
      where: { conversationId: id },
      orderBy: { createdAt: "asc" },
      take: limit + 1,
      include: { attachments: true },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
    });

    const hasNextPage = messages.length > limit;
    const page = hasNextPage ? messages.slice(0, limit) : messages;
    const nextCursor = hasNextPage ? page[page.length - 1]?.id : null;
    const items = await serializeMessagesWithAttachments(page);

    return { items, pageInfo: { hasNextPage, nextCursor } };
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

    const userMessage = await recordUserMessage({
      conversationId: conversation.id,
      content: parsedBody.data.content
    });

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

    const finalizeAssistantMessage = async (content: string, tokenCount: number | null) => {
      const assistantMessage = await persistAssistantMessage({
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
        latestAssistantReply: content
      });

      if (imagePlan.type === "generate") {
        await attachAssistantMessageToRequest(imagePlan.imageRequestId, assistantMessage.id);
      }

      const withAttachments = await prisma.message.findUniqueOrThrow({
        where: { id: assistantMessage.id },
        include: { attachments: true }
      });
      const [serialized] = await serializeMessagesWithAttachments([withAttachments]);
      return serialized!;
    };

    if (!stream) {
      const startedAt = Date.now();
      const assistant = await generateCharacterReply({
        character,
        summary: conversation.summary,
        recentMessages: llmHistory,
        userInput: parsedBody.data.content,
        extraSystemInstruction
      });
      const latencyMs = Date.now() - startedAt;

      const assistantMessage = await finalizeAssistantMessage(assistant.content, assistant.tokenCount);

      logger.info(
        {
          userId: request.user.id,
          conversationId: conversation.id,
          latencyMs,
          tokenCount: assistant.tokenCount,
          imagePlan: imagePlan.type
        },
        "Generated assistant response"
      );

      return {
        userMessage,
        assistantMessage,
        ...imageResponseMeta(imagePlan)
      };
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
          extraSystemInstruction
        },
        (token) => {
          fullContent += token;
          reply.raw.write(`event: token\ndata: ${JSON.stringify({ token })}\n\n`);
        }
      );

      const storedContent = fullContent || assistant.content;
      const assistantMessage = await finalizeAssistantMessage(storedContent, assistant.tokenCount);

      const latencyMs = Date.now() - startedAt;
      logger.info(
        {
          userId: request.user.id,
          conversationId: conversation.id,
          latencyMs,
          tokenCount: assistant.tokenCount,
          imagePlan: imagePlan.type
        },
        "Streamed assistant response"
      );

      reply.raw.write(
        `event: done\ndata: ${JSON.stringify({
          tokenCount: assistant.tokenCount,
          assistantMessage,
          ...imageResponseMeta(imagePlan)
        })}\n\n`
      );
      reply.raw.end();
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
