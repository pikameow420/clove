import { env } from "../../lib/env";

export type FishAlignmentSegment = {
  text: string;
  start: number;
  end: number;
};

export type FishAlignment = {
  segments: FishAlignmentSegment[];
  audio_duration: number;
};

export type FishStreamChunk = {
  audio: Buffer;
  alignment: FishAlignment | null;
};

/**
 * Streams TTS audio from Fish Audio's SSE endpoint. Each SSE `data:` event
 * carries one base64-encoded audio chunk plus an alignment snapshot. The caller
 * forwards the decoded chunks to the client as they arrive.
 */
export async function* streamFishSpeech(args: {
  referenceId: string;
  text: string;
}): AsyncGenerator<FishStreamChunk, void, unknown> {
  const apiKey = env.FISH_AUDIO_API_KEY;
  if (!apiKey) {
    throw new Error("FISH_AUDIO_API_KEY is not configured");
  }

  const response = await fetch("https://api.fish.audio/v1/tts/stream/with-timestamp", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      model: env.FISH_TTS_MODEL,
    },
    body: JSON.stringify({
      text: args.text,
      reference_id: args.referenceId,
      format: "mp3",
      latency: "balanced",
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Fish TTS stream failed (${response.status}): ${body.slice(0, 300)}`);
  }

  if (!response.body) {
    throw new Error("Fish TTS stream response had no body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";

    for (const eventText of events) {
      const dataLine = eventText
        .split("\n")
        .find((line) => line.startsWith("data: "));
      if (!dataLine) continue;

      const payload = JSON.parse(dataLine.slice("data: ".length)) as {
        audio_base64?: string;
        alignment?: FishAlignment | null;
      };
      if (payload.audio_base64) {
        yield {
          audio: Buffer.from(payload.audio_base64, "base64"),
          alignment: payload.alignment ?? null,
        };
      }
    }
  }
}

/**
 * Consumes the full stream and returns the concatenated audio plus the final
 * alignment snapshot (which carries the complete word-level timestamps and the
 * total audio duration). Used by the non-streaming `/tts` route so the client
 * can drive waveform progress from real timestamps.
 */
export async function collectFishSpeech(args: {
  referenceId: string;
  text: string;
}): Promise<{ audio: Buffer; alignment: FishAlignment | null }> {
  const chunks: Buffer[] = [];
  let alignment: FishAlignment | null = null;
  for await (const chunk of streamFishSpeech(args)) {
    chunks.push(chunk.audio);
    if (chunk.alignment) {
      alignment = chunk.alignment;
    }
  }
  return { audio: Buffer.concat(chunks), alignment };
}