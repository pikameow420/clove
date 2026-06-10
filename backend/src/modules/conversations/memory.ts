import type { Message } from "../../generated/prisma/client";
import {
  shouldUpdateMemory,
  updateConversationMemory
} from "../llm/conversation-memory";

export async function refreshConversationMemory(params: {
  characterName: string;
  existingSummary: string | null;
  allMessages: Message[];
  latestUserInput: string;
  latestAssistantReply: string;
}): Promise<string | null> {
  const messageCount = params.allMessages.length;
  if (!shouldUpdateMemory(messageCount, params.existingSummary)) {
    return params.existingSummary;
  }

  return updateConversationMemory({
    characterName: params.characterName,
    existingMemory: params.existingSummary,
    recentMessages: params.allMessages,
    latestUserInput: params.latestUserInput,
    latestAssistantReply: params.latestAssistantReply,
    messageCount
  });
}
