import { env } from "../../lib/env";
import type { LlmChatMessage, LlmChatOptions, LlmChatResult, LlmTokenHandler } from "./types";

type OllamaStreamChunk = {
  done: boolean;
  message?: {
    role: "assistant";
    content: string;
  };
  prompt_eval_count?: number;
  eval_count?: number;
};

function withTimeoutSignal(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}

/** Set at boot by the env schema whenever LLM_PROVIDER is "ollama". */
function requireOllamaConfig(): { baseUrl: string; model: string } {
  if (!env.OLLAMA_BASE_URL || !env.OLLAMA_MODEL) {
    throw new Error("Ollama is not configured: set OLLAMA_BASE_URL and OLLAMA_MODEL");
  }
  return { baseUrl: env.OLLAMA_BASE_URL, model: env.OLLAMA_MODEL };
}

export function buildOllamaRequestBody(
  messages: LlmChatMessage[],
  stream: boolean,
  options?: LlmChatOptions
) {
  return {
    model: requireOllamaConfig().model,
    stream,
    messages,
    ...(options?.responseFormat === "json" ? { format: "json" as const } : {}),
    options: {
      temperature: options?.temperature ?? 0.8,
      num_predict: options?.maxTokens ?? 256
    }
  };
}

export async function chatWithOllama(
  messages: LlmChatMessage[],
  options?: LlmChatOptions
): Promise<LlmChatResult> {
  const response = await fetch(`${requireOllamaConfig().baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: withTimeoutSignal(env.LLM_TIMEOUT_MS),
    body: JSON.stringify(buildOllamaRequestBody(messages, false, options))
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Ollama error ${response.status}: ${errBody}`);
  }

  const json = (await response.json()) as OllamaStreamChunk;
  const content = json.message?.content ?? "";
  const tokenCount =
    typeof json.eval_count === "number" && typeof json.prompt_eval_count === "number"
      ? json.eval_count + json.prompt_eval_count
      : null;

  return { content, tokenCount };
}

export async function streamChatWithOllama(
  messages: LlmChatMessage[],
  onToken: LlmTokenHandler,
  options?: LlmChatOptions
): Promise<LlmChatResult> {
  const response = await fetch(`${requireOllamaConfig().baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: withTimeoutSignal(env.LLM_TIMEOUT_MS),
    body: JSON.stringify(buildOllamaRequestBody(messages, true, options))
  });

  if (!response.ok || !response.body) {
    const errBody = await response.text();
    throw new Error(`Ollama stream error ${response.status}: ${errBody}`);
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
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      const chunk = JSON.parse(trimmed) as OllamaStreamChunk;
      if (chunk.message?.content) {
        fullContent += chunk.message.content;
        onToken(chunk.message.content);
      }

      if (chunk.done) {
        if (typeof chunk.eval_count === "number" && typeof chunk.prompt_eval_count === "number") {
          tokenCount = chunk.eval_count + chunk.prompt_eval_count;
        }
      }
    }
  }

  return { content: fullContent, tokenCount };
}
