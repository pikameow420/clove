import type { Conversation } from "../../generated/prisma/client";
import { prisma } from "../../lib/db/prisma";
import { pickOpeningMessage } from "../characters/opening-message";

export async function assertConversationOwnership(
  conversationId: string,
  userId: string,
): Promise<Conversation> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
  });

  if (!conversation || conversation.userId !== userId) {
    throw new Error("NOT_FOUND");
  }

  return conversation;
}

export async function getOrCreateConversation(
  userId: string,
  characterId: string,
): Promise<Conversation> {
  const liked = await prisma.swipe.findUnique({
    where: {
      userId_characterId: {
        userId,
        characterId,
      },
    },
    select: { decision: true },
  });

  if (!liked || liked.decision !== "liked") {
    throw new Error("NOT_MATCHED");
  }

  const existing = await prisma.conversation.findUnique({
    where: {
      userId_characterId: {
        userId,
        characterId,
      },
    },
  });

  if (existing) {
    return existing;
  }

  const character = await prisma.character.findUniqueOrThrow({
    where: { id: characterId },
    select: { name: true, openingMessages: true },
  });

  const opener = pickOpeningMessage(character.openingMessages, character.name);
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    const conversation = await tx.conversation.create({
      data: {
        userId,
        characterId,
        lastMessageAt: now,
      },
    });

    await tx.message.create({
      data: {
        conversationId: conversation.id,
        role: "assistant",
        content: opener,
        createdAt: now,
      },
    });

    return conversation;
  });
}
