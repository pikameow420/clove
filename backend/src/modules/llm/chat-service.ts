import type { Character, Message } from "../../generated/prisma/client";
import { env } from "../../lib/env";
import { buildLlmMessages } from "./prompt-builder";
import { llmChat, llmChatStream } from "./provider";
import { parseRoleplaySegments, type RoleplaySegment } from "./roleplay";
import type { LlmTokenHandler } from "./types";

type ChatArgs = {
  character: Character;
  summary: string | null;
  recentMessages: Message[];
  userInput: string;
  extraSystemInstruction?: string;
  intimacyLevel?: number;
};

export type CharacterReply = {
  /** Raw reply text, narration markers included, kept as LLM history context. */
  content: string;
  tokenCount: number | null;
  /** Null when roleplay is disabled or the reply is plain dialogue. */
  segments: RoleplaySegment[] | null;
};

/** Plain texting stays snappy; roleplay needs room for a scene beat + dialogue. */
const TEXTING_MAX_TOKENS = 256;
const ROLEPLAY_MAX_TOKENS = 512;

function sanitizeAssistantText(content: string): string {
  return content.replace(/[\u2014\u2013]/g, ",");
}

function replyOptions() {
  return {
    maxTokens: env.ROLEPLAY_ENABLED ? ROLEPLAY_MAX_TOKENS : TEXTING_MAX_TOKENS
  };
}

/**
 * Segments are only worth storing when they actually change rendering, so a
 * reply that is a single dialogue block stays null and the client falls back to
 * the plain content path.
 */
export function roleplaySegmentsForReply(content: string): RoleplaySegment[] | null {
  if (!env.ROLEPLAY_ENABLED) {
    return null;
  }

  const segments = parseRoleplaySegments(content);
  if (segments.length === 0) {
    return null;
  }
  if (segments.length === 1 && segments[0]!.type === "dialogue") {
    return null;
  }
  return segments;
}

export async function generateCharacterReply(args: ChatArgs): Promise<CharacterReply> {
  const reply = await llmChat(buildLlmMessages(args), replyOptions());
  const content = sanitizeAssistantText(reply.content);
  return { content, tokenCount: reply.tokenCount, segments: roleplaySegmentsForReply(content) };
}

export async function generateCharacterReplyStream(
  args: ChatArgs,
  onToken: LlmTokenHandler
): Promise<CharacterReply> {
  const reply = await llmChatStream(buildLlmMessages(args), (token) => {
    onToken(sanitizeAssistantText(token));
  }, replyOptions());
  const content = sanitizeAssistantText(reply.content);
  return { content, tokenCount: reply.tokenCount, segments: roleplaySegmentsForReply(content) };
}
