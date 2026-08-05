import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { env, fishTtsEnabled } from "../../lib/env";
import { synthesizeFishSpeech } from "./fish-client";
import { resolveVoiceForCharacter } from "./voice-service";

/**
 * Backend-authoritative voice resolution. The client sends only `characterId`
 * and the backend resolves the Fish voice id from the `Voice` table
 * (ownership-checked), so fishVoiceIds never ship in the app bundle.
 */
const bodySchema = z.object({
  text: z.string().trim().min(1).max(env.FISH_TTS_MAX_CHARS),
  characterId: z.string().trim().min(1).max(64),
  characterName: z.string().trim().max(128).nullish()
});

export const ttsRoutes: FastifyPluginAsync = async (app) => {
  app.post("/tts", async (request, reply) => {
    if (!fishTtsEnabled) {
      return reply.code(503).send({ error: "TTS_DISABLED", message: "Fish TTS is not enabled" });
    }

    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    try {
      const resolved = await resolveVoiceForCharacter(parsed.data.characterId, request.user.id);
      if (!resolved) {
        return reply.code(403).send({
          error: "VOICE_UNAVAILABLE",
          message: "Character not found, not liked, or has no configured voice"
        });
      }

      console.log(
        `[TTS][route] referenceId=${resolved.fishVoiceId} ` +
          `characterId=${parsed.data.characterId} ` +
          `characterName="${resolved.characterName}" ` +
          `text="${parsed.data.text.slice(0, 40)}"`
      );
      const result = await synthesizeFishSpeech({
        referenceId: resolved.fishVoiceId,
        text: parsed.data.text,
        characterId: parsed.data.characterId,
        characterName: resolved.characterName
      });

      return {
        contentType: result.contentType,
        cached: result.cached,
        audioBase64: result.audio.toString("base64")
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "TTS failed";
      request.log.error({ err: error }, "Fish TTS synthesis failed");
      return reply.code(502).send({ error: "TTS_UPSTREAM", message: "Could not synthesize speech" });
    }
  });
};