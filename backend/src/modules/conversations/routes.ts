import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/db/prisma";
import { env } from "../../lib/env";
import { parsePositiveInt } from "../../lib/pagination";
import { logger } from "../../lib/logger";
import { generateCharacterReply, generateCharacterReplyStream } from "../llm/chat-service";
import { refreshConversationMemory } from "./memory";
import { assertConversationOwnership, getOrCreateConversation } from "./service";

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

    const conversations = await Promise.all(
      likes.map((swipe) => getOrCreateConversation(request.user.id, swipe.characterId))
    );

    const latestByConversation = await prisma.message.groupBy({
      by: ["conversationId"],
      where: {
        conversationId: {
          in: conversations.map((conversation) => conversation.id)
        }
      },
      _max: {
        createdAt: true
      }
    });

    const latestMap = new Map(
      latestByConversation.map((item) => [item.conversationId, item._max.createdAt?.toISOString() ?? null])
    );

    const items = likes.map((swipe) => {
      const conversation = conversations.find((entry) => entry.characterId === swipe.characterId)!;
      return {
        conversationId: conversation.id,
        character: swipe.character,
        lastMessageAt: latestMap.get(conversation.id) ?? conversation.lastMessageAt?.toISOString() ?? null,
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
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
    });

    const hasNextPage = messages.length > limit;
    const items = hasNextPage ? messages.slice(0, limit) : messages;
    const nextCursor = hasNextPage ? items[items.length - 1]?.id : null;

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

    const userMessage = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: "user",
        content: parsedBody.data.content
      }
    });

    const recentMessages = await prisma.message.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: "asc" },
      take: env.MAX_CONTEXT_MESSAGES
    });

    if (!stream) {
      const startedAt = Date.now();
      const assistant = await generateCharacterReply({
        character,
        summary: conversation.summary,
        recentMessages,
        userInput: parsedBody.data.content
      });
      const latencyMs = Date.now() - startedAt;

      const assistantMessage = await prisma.message.create({
        data: {
          conversationId: conversation.id,
          role: "assistant",
          content: assistant.content,
          tokenCount: assistant.tokenCount ?? undefined
        }
      });

      const nextSummary = await refreshConversationMemory({
        characterName: character.name,
        existingSummary: conversation.summary,
        allMessages: [...recentMessages, assistantMessage],
        latestUserInput: parsedBody.data.content,
        latestAssistantReply: assistant.content
      });

      await prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          lastMessageAt: assistantMessage.createdAt,
          summary: nextSummary
        }
      });

      logger.info(
        {
          userId: request.user.id,
          conversationId: conversation.id,
          latencyMs,
          tokenCount: assistant.tokenCount
        },
        "Generated assistant response"
      );

      return {
        userMessage,
        assistantMessage
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
          recentMessages,
          userInput: parsedBody.data.content
        },
        (token) => {
          fullContent += token;
          reply.raw.write(`event: token\ndata: ${JSON.stringify({ token })}\n\n`);
        }
      );

      const assistantMessage = await prisma.message.create({
        data: {
          conversationId: conversation.id,
          role: "assistant",
          content: assistant.content,
          tokenCount: assistant.tokenCount ?? undefined
        }
      });

      const nextSummary = await refreshConversationMemory({
        characterName: character.name,
        existingSummary: conversation.summary,
        allMessages: [...recentMessages, assistantMessage],
        latestUserInput: parsedBody.data.content,
        latestAssistantReply: assistant.content
      });

      await prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          lastMessageAt: assistantMessage.createdAt,
          summary: nextSummary
        }
      });

      const latencyMs = Date.now() - startedAt;
      logger.info(
        {
          userId: request.user.id,
          conversationId: conversation.id,
          latencyMs,
          tokenCount: assistant.tokenCount
        },
        "Streamed assistant response"
      );

      reply.raw.write(`event: done\ndata: ${JSON.stringify({ tokenCount: assistant.tokenCount })}\n\n`);
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
