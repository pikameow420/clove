import type { Message } from "../../generated/prisma/client";
import { prisma } from "../../lib/db/prisma";
import {
  PROACTIVE_REPLY_WINDOW_MS,
  classifyUserMessage,
  endOfUtcDay,
  startOfUtcDay,
  utcDayKey,
} from "./rules";
import type { IntimacyEventInput } from "./scoring";

/**
 * Builds chat-side intimacy events for a newly persisted user message:
 * regular/meaningful (mutually exclusive), answered_question, proactive_reply.
 * shared_day is awarded when an assistant message is later persisted the same UTC day.
 */
export async function buildUserMessageIntimacyEvents(params: {
  conversationId: string;
  userMessage: Message;
  previousAssistantContent?: string | null;
  now?: Date;
}): Promise<IntimacyEventInput[]> {
  const now = params.now ?? new Date();
  const events: IntimacyEventInput[] = [];
  const messageClass = classifyUserMessage(params.userMessage.content);

  if (messageClass === "filler") {
    return events;
  }

  events.push({
    eventType: messageClass === "meaningful" ? "user_message_meaningful" : "user_message",
    sourceId: params.userMessage.id,
  });

  const previousContent =
    params.previousAssistantContent ??
    (
      await prisma.message.findFirst({
        where: {
          conversationId: params.conversationId,
          role: "assistant",
          createdAt: { lt: params.userMessage.createdAt },
        },
        orderBy: { createdAt: "desc" },
        select: { content: true },
      })
    )?.content;

  if (previousContent?.includes("?")) {
    events.push({
      eventType: "answered_question",
      sourceId: params.userMessage.id,
    });
  }

  const latestProactive = await prisma.message.findFirst({
    where: {
      conversationId: params.conversationId,
      source: "assistant_proactive",
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, createdAt: true },
  });

  if (
    latestProactive &&
    now.getTime() - latestProactive.createdAt.getTime() <= PROACTIVE_REPLY_WINDOW_MS
  ) {
    events.push({
      eventType: "proactive_reply",
      sourceId: latestProactive.id,
    });
  }

  return events;
}

export async function buildSharedDayEvent(params: {
  conversationId: string;
  now?: Date;
}): Promise<IntimacyEventInput | null> {
  const now = params.now ?? new Date();
  const dayStart = startOfUtcDay(now);
  const dayEnd = endOfUtcDay(now);

  const [userToday, assistantToday] = await Promise.all([
    prisma.message.findFirst({
      where: {
        conversationId: params.conversationId,
        role: "user",
        createdAt: { gte: dayStart, lt: dayEnd },
      },
      select: { id: true },
    }),
    prisma.message.findFirst({
      where: {
        conversationId: params.conversationId,
        role: "assistant",
        createdAt: { gte: dayStart, lt: dayEnd },
      },
      select: { id: true },
    }),
  ]);

  if (!userToday || !assistantToday) {
    return null;
  }

  return {
    eventType: "shared_day",
    sourceId: `day-${utcDayKey(now)}`,
  };
}
