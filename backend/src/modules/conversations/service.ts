import type { Conversation } from "../../generated/prisma/client";
import { prisma } from "../../lib/db/prisma";

export async function assertConversationOwnership(conversationId: string, userId: string): Promise<Conversation> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId }
  });

  if (!conversation || conversation.userId !== userId) {
    throw new Error("NOT_FOUND");
  }

  return conversation;
}

export async function getOrCreateConversation(userId: string, characterId: string): Promise<Conversation> {
  const liked = await prisma.swipe.findUnique({
    where: {
      userId_characterId: {
        userId,
        characterId
      }
    },
    select: { decision: true }
  });

  if (!liked || liked.decision !== "liked") {
    throw new Error("NOT_MATCHED");
  }

  return prisma.conversation.upsert({
    where: {
      userId_characterId: {
        userId,
        characterId
      }
    },
    update: {},
    create: {
      userId,
      characterId
    }
  });
}
