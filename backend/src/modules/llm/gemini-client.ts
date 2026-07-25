import { env } from "../../lib/env";
import {
  LlmBlockedError,
  type LlmChatMessage,
  type LlmChatOptions,
  type LlmChatResult,
  type LlmTokenHandler
} from "./types";

type GeminiPart = { text: string; thought?: boolean };

type GeminiContent = {
  role: "user" | "model";
  parts: GeminiPart[];
};

type GeminiSafetySetting = {
  category: string;
  threshold: string;
};

export type GeminiRequestBody = {
  contents: GeminiContent[];
  systemInstruction?: { parts: GeminiPart[] };
  generationConfig: {
    temperature: number;
    maxOutputTokens: number;
    responseMimeType?: string;
    thinkingConfig?: { thinkingLevel: string };
  };
  safetySettings: GeminiSafetySetting[];
};

export type GeminiResponseBody = {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
  };
};

/**
 * This app is an adult fiction product, so the default filters reject ordinary
 * in-character romance. Category-level blocking is disabled and safety is
 * enforced upstream instead: age gating, the image-intent classifier, and the
 * hard-reject patterns in modules/images/image-intent.
 */
const SAFETY_SETTINGS: GeminiSafetySetting[] = [
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
];

/** Gemini rejects a request whose final turn is from the model. */
const CONTINUATION_NUDGE = "(continue)";

function toGeminiRole(role: "user" | "assistant"): "user" | "model" {
  return role === "assistant" ? "model" : "user";
}

/**
 * Folds every system message into systemInstruction and collapses consecutive
 * same-role turns, which is the shape the generateContent API expects.
 */
export function toGeminiRequestBody(
  messages: LlmChatMessage[],
  options?: LlmChatOptions
): GeminiRequestBody {
  const systemTexts: string[] = [];
  const contents: GeminiContent[] = [];

  for (const message of messages) {
    const text = message.content.trim();
    if (!text) {
      continue;
    }

    if (message.role === "system") {
      systemTexts.push(text);
      continue;
    }

    const role = toGeminiRole(message.role);
    const previous = contents[contents.length - 1];
    if (previous && previous.role === role) {
      previous.parts.push({ text });
      continue;
    }

    contents.push({ role, parts: [{ text }] });
  }

  const last = contents[contents.length - 1];
  if (!last || last.role === "model") {
    contents.push({ role: "user", parts: [{ text: CONTINUATION_NUDGE }] });
  }

  return {
    contents,
    ...(systemTexts.length > 0
      ? { systemInstruction: { parts: [{ text: systemTexts.join("\n\n") }] } }
      : {}),
    generationConfig: {
      temperature: options?.temperature ?? 0.8,
      maxOutputTokens: options?.maxTokens ?? 256,
      ...(options?.responseFormat === "json" ? { responseMimeType: "application/json" } : {}),
      ...(env.GEMINI_THINKING_LEVEL === "off"
        ? {}
        : { thinkingConfig: { thinkingLevel: env.GEMINI_THINKING_LEVEL.toUpperCase() } })
    },
    safetySettings: SAFETY_SETTINGS
  };
}

/** Thought parts are internal reasoning and must never reach the user. */
function extractText(parts: GeminiPart[] | undefined): string {
  if (!parts) {
    return "";
  }
  return parts
    .filter((part) => part.thought !== true && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function extractTokenCount(usage: GeminiResponseBody["usageMetadata"]): number | null {
  if (!usage) {
    return null;
  }
  if (typeof usage.totalTokenCount === "number") {
    return usage.totalTokenCount;
  }
  const prompt = usage.promptTokenCount;
  const candidates = usage.candidatesTokenCount;
  if (typeof prompt === "number" && typeof candidates === "number") {
    return prompt + candidates;
  }
  return null;
}

export function parseGeminiResponse(body: GeminiResponseBody): LlmChatResult {
  const blockReason = body.promptFeedback?.blockReason;
  if (blockReason) {
    throw new LlmBlockedError(blockReason);
  }

  const candidate = body.candidates?.[0];
  const content = extractText(candidate?.content?.parts);

  // MAX_TOKENS still yields usable text, so only an empty refusal is fatal.
  if (!content && candidate?.finishReason && candidate.finishReason !== "STOP") {
    throw new LlmBlockedError(candidate.finishReason);
  }

  return { content, tokenCount: extractTokenCount(body.usageMetadata) };
}

function endpoint(method: "generateContent" | "streamGenerateContent"): string {
  const base = `${env.GEMINI_BASE_URL}/models/${env.GEMINI_MODEL}:${method}`;
  return method === "streamGenerateContent" ? `${base}?alt=sse` : base;
}

async function postToGemini(
  method: "generateContent" | "streamGenerateContent",
  body: GeminiRequestBody
): Promise<Response> {
  const response = await fetch(endpoint(method), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": env.GEMINI_API_KEY ?? ""
    },
    signal: AbortSignal.timeout(env.LLM_TIMEOUT_MS),
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Gemini error ${response.status}: ${errBody}`);
  }

  return response;
}

export async function chatWithGemini(
  messages: LlmChatMessage[],
  options?: LlmChatOptions
): Promise<LlmChatResult> {
  const response = await postToGemini("generateContent", toGeminiRequestBody(messages, options));
  return parseGeminiResponse((await response.json()) as GeminiResponseBody);
}

/**
 * Splits an SSE buffer into complete events, returning the leftover partial
 * event so the caller can prepend it to the next chunk.
 */
export function splitSseEvents(buffer: string): { events: string[]; rest: string } {
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  return { events: parts, rest };
}

/** Returns the JSON payload of an SSE event, or null for comments and heartbeats. */
export function parseSseEvent(rawEvent: string): GeminiResponseBody | null {
  const data = rawEvent
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .join("");

  if (!data || data === "[DONE]") {
    return null;
  }

  return JSON.parse(data) as GeminiResponseBody;
}

export async function streamChatWithGemini(
  messages: LlmChatMessage[],
  onToken: LlmTokenHandler,
  options?: LlmChatOptions
): Promise<LlmChatResult> {
  const response = await postToGemini(
    "streamGenerateContent",
    toGeminiRequestBody(messages, options)
  );

  if (!response.body) {
    throw new Error("Gemini stream response had no body");
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
      const chunk = parseSseEvent(rawEvent);
      if (!chunk) {
        continue;
      }

      if (chunk.promptFeedback?.blockReason) {
        throw new LlmBlockedError(chunk.promptFeedback.blockReason);
      }

      const token = extractText(chunk.candidates?.[0]?.content?.parts);
      if (token) {
        fullContent += token;
        onToken(token);
      }

      const chunkTokens = extractTokenCount(chunk.usageMetadata);
      if (chunkTokens !== null) {
        tokenCount = chunkTokens;
      }
    }
  }

  return { content: fullContent, tokenCount };
}
