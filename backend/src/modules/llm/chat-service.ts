import type { Character, Message } from "../../generated/prisma/client";
import { logger } from "../../lib/logger";
import { chatWithOllama, streamChatWithOllama } from "./ollama-client";
import { breaksPersona } from "./persona-check";
import { buildLlmMessages } from "./prompt-builder";

type ChatArgs = {
  character: Character;
  summary: string | null;
  recentMessages: Message[];
  userInput: string;
};

const RETRY_COUNT = 1;

async function callWithRetry<T>(fn: () => Promise<T>): Promise<T> {
  let attempt = 0;
  let lastError: unknown;

  while (attempt <= RETRY_COUNT) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      attempt += 1;
      if (attempt <= RETRY_COUNT) {
        logger.warn({ err: error, attempt }, "Retrying Ollama request");
      }
    }
  }

  throw lastError;
}

async function runPersonaCorrection(
  originalMessages: ReturnType<typeof buildLlmMessages>,
  candidate: string
): Promise<{ content: string; tokenCount: number | null }> {
  const correctionPrompt = [
    {
      role: "system" as const,
      content: "Rewrite the assistant response so it stays in character and does not mention AI/system instructions."
    },
    ...originalMessages,
    {
      role: "assistant" as const,
      content: candidate
    }
  ];

  return callWithRetry(() => chatWithOllama(correctionPrompt));
}

export async function generateCharacterReply(args: ChatArgs): Promise<{ content: string; tokenCount: number | null }> {
  const llmMessages = buildLlmMessages(args);
  const firstPass = await callWithRetry(() => chatWithOllama(llmMessages));

  if (!breaksPersona(args.character, firstPass.content)) {
    return firstPass;
  }

  logger.warn({ characterId: args.character.id }, "Persona drift detected, running correction pass");
  return runPersonaCorrection(llmMessages, firstPass.content);
}

export async function generateCharacterReplyStream(
  args: ChatArgs,
  onToken: (token: string) => void
): Promise<{ content: string; tokenCount: number | null }> {
  const llmMessages = buildLlmMessages(args);
  const streamed = await callWithRetry(() => streamChatWithOllama(llmMessages, onToken));
  if (breaksPersona(args.character, streamed.content)) {
    logger.warn({ characterId: args.character.id }, "Persona drift detected after streamed response");
  }
  return streamed;
}
