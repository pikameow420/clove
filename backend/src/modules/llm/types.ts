/**
 * Provider-neutral chat contract. Both the Ollama and Gemini clients implement
 * this so call sites never depend on a specific vendor's wire format.
 */

export type LlmChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

/**
 * "json" asks the provider for a strict JSON object. Gemini enforces this
 * natively; Ollama only gets a prompt-level nudge, so callers must still be
 * able to cope with surrounding prose.
 */
export type LlmResponseFormat = "text" | "json";

export type LlmChatOptions = {
  temperature?: number;
  maxTokens?: number;
  responseFormat?: LlmResponseFormat;
};

export type LlmChatResult = {
  content: string;
  /** Total prompt + completion tokens, or null when the provider omits usage. */
  tokenCount: number | null;
};

export type LlmTokenHandler = (token: string) => void;

/** Thrown when a provider refuses to generate, as opposed to failing. */
export class LlmBlockedError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`LLM refused to generate content: ${reason}`);
    this.name = "LlmBlockedError";
    this.reason = reason;
  }
}
