import type { Character, Message } from "../../generated/prisma/client";
import { chatWithOllama, streamChatWithOllama } from "./ollama-client";
import { buildLlmMessages } from "./prompt-builder";

type ChatArgs = {
  character: Character;
  summary: string | null;
  recentMessages: Message[];
  userInput: string;
  extraSystemInstruction?: string;
  intimacyLevel?: number;
};

function sanitizeAssistantText(content: string): string {
  return content.replace(/[\u2014\u2013]/g, ",");
}

export async function generateCharacterReply(args: ChatArgs): Promise<{ content: string; tokenCount: number | null }> {
  const llmMessages = buildLlmMessages(args);
  const reply = await chatWithOllama(llmMessages);
  return { ...reply, content: sanitizeAssistantText(reply.content) };
}

export async function generateCharacterReplyStream(
  args: ChatArgs,
  onToken: (token: string) => void
): Promise<{ content: string; tokenCount: number | null }> {
  const llmMessages = buildLlmMessages(args);
  const reply = await streamChatWithOllama(llmMessages, (token) => {
    onToken(sanitizeAssistantText(token));
  });
  return { ...reply, content: sanitizeAssistantText(reply.content) };
}
