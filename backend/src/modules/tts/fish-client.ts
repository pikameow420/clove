import { createHash } from "node:crypto";
import { env } from "../../lib/env";

const audioCache = new Map<string, Buffer>();
const CACHE_MAX_ENTRIES = 200;

function cacheKey(referenceId: string, text: string): string {
  return createHash("sha256").update(`${referenceId}\0${text}`).digest("hex");
}

function remember(key: string, buffer: Buffer): void {
  if (audioCache.size >= CACHE_MAX_ENTRIES) {
    const oldest = audioCache.keys().next().value;
    if (oldest) audioCache.delete(oldest);
  }
  audioCache.set(key, buffer);
}

export type FishTtsResult = {
  audio: Buffer;
  contentType: "audio/mpeg";
  cached: boolean;
};

/**
 * Synthesize MP3 via Fish Audio. The client owns the voice catalog and sends
 * a fully-resolved `referenceId`, so this stays a pure synthesizer: no map
 * lookups, no DB reads — just synthesis + cache keyed by referenceId+text.
 */
export async function synthesizeFishSpeech(args: {
  referenceId: string;
  text: string;
  characterId?: string | null;
  characterName?: string | null;
}): Promise<FishTtsResult> {
  const apiKey = env.FISH_AUDIO_API_KEY;
  if (!apiKey) {
    throw new Error("FISH_AUDIO_API_KEY is not configured");
  }

  console.log(
    `[TTS][fishClient] referenceId=${args.referenceId} ` +
      `characterId=${args.characterId ?? "<none>"} ` +
      `characterName="${args.characterName ?? "unknown"}" ` +
      `text="${args.text.slice(0, 40)}"`
  );

  const key = cacheKey(args.referenceId, args.text);
  const hit = audioCache.get(key);
  if (hit) {
    return { audio: hit, contentType: "audio/mpeg", cached: true };
  }

  const response = await fetch("https://api.fish.audio/v1/tts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: args.text,
      reference_id: args.referenceId,
      model: env.FISH_TTS_MODEL,
      format: "mp3",
      mp3_bitrate: 128,
      latency: "normal",
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Fish TTS failed (${response.status}): ${body.slice(0, 300)}`);
  }

  const audio = Buffer.from(await response.arrayBuffer());
  remember(key, audio);
  return { audio, contentType: "audio/mpeg", cached: false };
}