import type { Message } from "../../generated/prisma/client";
import {
  shouldUpdateMemory,
  updateConversationMemory
} from "../llm/conversation-memory";

export type ConversationMemoryRefresh = {
  summary: string | null;
  warmthPoints: number | null;
};

export async function refreshConversationMemory(params: {
  characterName: string;
  existingSummary: string | null;
  allMessages: Message[];
  latestUserInput: string;
  latestAssistantReply: string;
}): Promise<ConversationMemoryRefresh> {
  const messageCount = params.allMessages.length;
  if (!shouldUpdateMemory(messageCount, params.existingSummary)) {
    return { summary: params.existingSummary, warmthPoints: null };
  }

  const updated = await updateConversationMemory({
    characterName: params.characterName,
    existingMemory: params.existingSummary,
    recentMessages: params.allMessages,
    latestUserInput: params.latestUserInput,
    latestAssistantReply: params.latestAssistantReply,
    messageCount
  });

  return { summary: updated.summary, warmthPoints: updated.warmthPoints };
}
