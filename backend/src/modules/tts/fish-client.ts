import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { env } from "../../lib/env";

const mapPath = join(process.cwd(), "data/fish-voice-map.json");

type VoiceMap = Record<string, string>;

let voiceMap: VoiceMap | null = null;

function loadVoiceMap(): VoiceMap {
  if (voiceMap) return voiceMap;
  const raw = JSON.parse(readFileSync(mapPath, "utf8")) as unknown;
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid fish-voice-map.json");
  }
  voiceMap = raw as VoiceMap;
  return voiceMap;
}

export function resolveFishVoiceId(voiceKey: string): string | null {
  const map = loadVoiceMap();
  const id = map[voiceKey];
  return typeof id === "string" && id.length > 0 ? id : null;
}

const audioCache = new Map<string, Buffer>();
const CACHE_MAX_ENTRIES = 200;

function cacheKey(voiceKey: string, text: string): string {
  return createHash("sha256").update(`${voiceKey}\0${text}`).digest("hex");
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
 * Synthesize MP3 via Fish Audio. Uses in-memory cache keyed by voiceKey+text.
 */
export async function synthesizeFishSpeech(args: {
  voiceKey: string;
  text: string;
}): Promise<FishTtsResult> {
  const apiKey = env.FISH_AUDIO_API_KEY;
  if (!apiKey) {
    throw new Error("FISH_AUDIO_API_KEY is not configured");
  }

  const referenceId = resolveFishVoiceId(args.voiceKey);
  if (!referenceId) {
    throw new Error(`Unknown voiceKey: ${args.voiceKey}`);
  }

  const key = cacheKey(args.voiceKey, args.text);
  const hit = audioCache.get(key);
  if (hit) {
    return { audio: hit, contentType: "audio/mpeg", cached: true };
  }

  const response = await fetch("https://api.fish.audio/v1/tts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      model: env.FISH_TTS_MODEL
    },
    body: JSON.stringify({
      text: args.text,
      reference_id: referenceId,
      format: "mp3",
      mp3_bitrate: 128,
      latency: "normal"
    })
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Fish TTS failed (${response.status}): ${body.slice(0, 300)}`);
  }

  const audio = Buffer.from(await response.arrayBuffer());
  remember(key, audio);
  return { audio, contentType: "audio/mpeg", cached: false };
}
