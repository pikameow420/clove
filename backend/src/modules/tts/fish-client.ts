import { createHash } from "node:crypto";
import { env } from "../../lib/env";
import { collectFishSpeech, type FishAlignment } from "./fish-stream-client";

const audioCache = new Map<string, { audio: Buffer; alignment: FishAlignment | null }>();
const CACHE_MAX_ENTRIES = 200;

function cacheKey(referenceId: string, text: string): string {
  return createHash("sha256").update(`${referenceId}\0${text}`).digest("hex");
}

function remember(key: string, entry: { audio: Buffer; alignment: FishAlignment | null }): void {
  if (audioCache.size >= CACHE_MAX_ENTRIES) {
    const oldest = audioCache.keys().next().value;
    if (oldest) audioCache.delete(oldest);
  }
  audioCache.set(key, entry);
}

export type FishTtsResult = {
  audio: Buffer;
  contentType: "audio/mpeg";
  cached: boolean;
  /** Word-level timestamps + total duration from Fish's streaming endpoint. */
  alignment: FishAlignment | null;
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
    return { audio: hit.audio, contentType: "audio/mpeg", cached: true, alignment: hit.alignment };
  }

  // Use the streaming endpoint internally so we get word-level alignment
  // timestamps (the non-streaming /v1/tts returns no duration metadata). The
  // chunks are concatenated into one complete MP3, keeping the client on the
  // RN-compatible non-streaming path.
  const { audio, alignment } = await collectFishSpeech({
    referenceId: args.referenceId,
    text: args.text
  });

  remember(key, { audio, alignment });
  return { audio, contentType: "audio/mpeg", cached: false, alignment };
}
