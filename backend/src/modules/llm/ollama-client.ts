import { env } from "../../lib/env";

type OllamaMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

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

export async function chatWithOllama(messages: OllamaMessage[]): Promise<{ content: string; tokenCount: number | null }> {
  const response = await fetch(`${env.OLLAMA_BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: withTimeoutSignal(env.LLM_TIMEOUT_MS),
    body: JSON.stringify({
      model: env.OLLAMA_MODEL,
      stream: false,
      messages
    })
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
  messages: OllamaMessage[],
  onToken: (token: string) => void
): Promise<{ content: string; tokenCount: number | null }> {
  const response = await fetch(`${env.OLLAMA_BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: withTimeoutSignal(env.LLM_TIMEOUT_MS),
    body: JSON.stringify({
      model: env.OLLAMA_MODEL,
      stream: true,
      messages
    })
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
