import { env } from "../../lib/env";
import { splitSseEvents } from "./gemini-client";
import type { LlmChatMessage, LlmChatOptions, LlmChatResult, LlmTokenHandler } from "./types";

type OpenRouterResponseBody = {
  choices?: Array<{
    message?: { content?: string };
    finish_reason?: string | null;
  }>;
  usage?: {
    total_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  error?: { message?: string };
};

type OpenRouterStreamChunk = {
  choices?: Array<{
    delta?: { content?: string };
    finish_reason?: string | null;
  }>;
  usage?: {
    total_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  error?: { message?: string };
};

/** Set at boot by the env schema whenever LLM_PROVIDER is "openrouter". */
function requireOpenRouterConfig(): { baseUrl: string; model: string; apiKey: string } {
  if (!env.OPENROUTER_API_KEY || !env.OPENROUTER_MODEL) {
    throw new Error("OpenRouter is not configured: set OPENROUTER_API_KEY and OPENROUTER_MODEL");
  }
  return {
    baseUrl: env.OPENROUTER_BASE_URL,
    model: env.OPENROUTER_MODEL,
    apiKey: env.OPENROUTER_API_KEY
  };
}

/**
 * OpenAI-compatible request body. OpenRouter proxies the Chat Completions API,
 * so the shape mirrors what the Ollama client sends but with the vendor's
 * field names (max_tokens, response_format). The model is passed in so this
 * stays a pure function that tests can call without env config.
 */
export function buildOpenRouterRequestBody(
  model: string,
  messages: LlmChatMessage[],
  stream: boolean,
  options?: LlmChatOptions
) {
  return {
    model,
    stream,
    messages,
    ...(options?.responseFormat === "json"
      ? { response_format: { type: "json_object" as const } }
      : {}),
    max_tokens: options?.maxTokens ?? 256,
    temperature: options?.temperature ?? 0.8
  };
}

export function parseOpenRouterResponse(body: OpenRouterResponseBody): LlmChatResult {
  if (body.error?.message) {
    throw new Error(`OpenRouter error: ${body.error.message}`);
  }
  const content = body.choices?.[0]?.message?.content ?? "";
  const tokenCount = typeof body.usage?.total_tokens === "number" ? body.usage.total_tokens : null;
  return { content, tokenCount };
}

/** Returns the JSON payload of an SSE event, or null for comments and [DONE]. */
export function parseOpenRouterSseEvent(rawEvent: string): OpenRouterStreamChunk | null {
  const data = rawEvent
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .join("");

  if (!data || data === "[DONE]") {
    return null;
  }

  return JSON.parse(data) as OpenRouterStreamChunk;
}

export async function chatWithOpenRouter(
  messages: LlmChatMessage[],
  options?: LlmChatOptions
): Promise<LlmChatResult> {
  const { baseUrl, model, apiKey } = requireOpenRouterConfig();
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    signal: AbortSignal.timeout(env.LLM_TIMEOUT_MS),
    body: JSON.stringify(buildOpenRouterRequestBody(model, messages, false, options))
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`OpenRouter error ${response.status}: ${errBody}`);
  }

  return parseOpenRouterResponse((await response.json()) as OpenRouterResponseBody);
}

export async function streamChatWithOpenRouter(
  messages: LlmChatMessage[],
  onToken: LlmTokenHandler,
  options?: LlmChatOptions
): Promise<LlmChatResult> {
  const { baseUrl, model, apiKey } = requireOpenRouterConfig();
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    signal: AbortSignal.timeout(env.LLM_TIMEOUT_MS),
    body: JSON.stringify(buildOpenRouterRequestBody(model, messages, true, options))
  });

  if (!response.ok || !response.body) {
    const errBody = await response.text();
    throw new Error(`OpenRouter stream error ${response.status}: ${errBody}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullContent = "";
  let tokenCount: number | null = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const { events, rest } = splitSseEvents(buffer);
    buffer = rest;

    for (const rawEvent of events) {
      const chunk = parseOpenRouterSseEvent(rawEvent);
      if (!chunk) {
        continue;
      }

      if (chunk.error?.message) {
        throw new Error(`OpenRouter stream error: ${chunk.error.message}`);
      }

      const token = chunk.choices?.[0]?.delta?.content ?? "";
      if (token) {
        fullContent += token;
        onToken(token);
      }

      if (typeof chunk.usage?.total_tokens === "number") {
        tokenCount = chunk.usage.total_tokens;
      }
    }
  }

  return { content: fullContent, tokenCount };
}