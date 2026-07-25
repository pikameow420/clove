import { env } from "../../lib/env";
import { chatWithGemini, streamChatWithGemini } from "./gemini-client";
import { chatWithOllama, streamChatWithOllama } from "./ollama-client";
import type { LlmChatMessage, LlmChatOptions, LlmChatResult, LlmTokenHandler } from "./types";

export type LlmProviderName = (typeof env)["LLM_PROVIDER"];

export function activeProvider(): LlmProviderName {
  return env.LLM_PROVIDER;
}

/**
 * Single entry point for non-streaming completions. Every caller goes through
 * here so switching LLM_PROVIDER swaps the model everywhere at once.
 */
export async function llmChat(
  messages: LlmChatMessage[],
  options?: LlmChatOptions
): Promise<LlmChatResult> {
  switch (env.LLM_PROVIDER) {
    case "ollama":
      return chatWithOllama(messages, options);
    case "gemini":
      return chatWithGemini(messages, options);
    default: {
      const exhaustive: never = env.LLM_PROVIDER;
      throw new Error(`Unhandled LLM provider: ${exhaustive}`);
    }
  }
}

export async function llmChatStream(
  messages: LlmChatMessage[],
  onToken: LlmTokenHandler,
  options?: LlmChatOptions
): Promise<LlmChatResult> {
  switch (env.LLM_PROVIDER) {
    case "ollama":
      return streamChatWithOllama(messages, onToken, options);
    case "gemini":
      return streamChatWithGemini(messages, onToken, options);
    default: {
      const exhaustive: never = env.LLM_PROVIDER;
      throw new Error(`Unhandled LLM provider: ${exhaustive}`);
    }
  }
}

/**
 * Requests a strict JSON object. Gemini enforces the mime type, Ollama gets its
 * own JSON format flag, but neither guarantees a bare object, so the payload is
 * still extracted defensively.
 */
export async function llmChatJson(
  messages: LlmChatMessage[],
  options?: Omit<LlmChatOptions, "responseFormat">
): Promise<LlmChatResult> {
  return llmChat(messages, { ...options, responseFormat: "json" });
}

export function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("No JSON object in model output");
  }
  return JSON.parse(text.slice(start, end + 1));
}
