import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { env, fishTtsEnabled } from "../../lib/env";
import { synthesizeFishSpeech } from "./fish-client";
import { streamFishSpeech } from "./fish-stream-client";
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
        audioBase64: result.audio.toString("base64"),
        alignment: result.alignment
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "TTS failed";
      request.log.error({ err: error }, "Fish TTS synthesis failed");
      return reply.code(502).send({ error: "TTS_UPSTREAM", message: "Could not synthesize speech" });
    }
  });

  /**
   * Streaming TTS: forwards Fish Audio's audio chunks to the client as a
   * progressive `audio/mpeg` HTTP response. The client plays the stream as it
   * arrives, so first audio is heard in ~300-500ms instead of after the full
   * file downloads.
   */
  app.get("/tts/stream", async (request, reply) => {
    if (!fishTtsEnabled) {
      return reply.code(503).send({ error: "TTS_DISABLED", message: "Fish TTS is not enabled" });
    }

    const query = request.query as { text?: string; characterId?: string };
    const text = typeof query.text === "string" ? query.text.trim() : "";
    const characterId = typeof query.characterId === "string" ? query.characterId.trim() : "";
    if (!text || text.length > env.FISH_TTS_MAX_CHARS || !characterId) {
      return reply.code(400).send({ error: "INVALID_BODY" });
    }

    let resolved;
    try {
      resolved = await resolveVoiceForCharacter(characterId, request.user.id);
    } catch (error) {
      request.log.error({ err: error }, "Fish TTS stream voice resolution failed");
      return reply.code(502).send({ error: "TTS_UPSTREAM", message: "Could not resolve voice" });
    }
    if (!resolved) {
      return reply.code(403).send({
        error: "VOICE_UNAVAILABLE",
        message: "Character not found, not liked, or has no configured voice"
      });
    }

    reply.raw.setHeader("Content-Type", "audio/mpeg");
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.flushHeaders();

    try {
      for await (const chunk of streamFishSpeech({
        referenceId: resolved.fishVoiceId,
        text
      })) {
        reply.raw.write(chunk.audio);
      }
      reply.raw.end();
    } catch (error) {
      request.log.error({ err: error }, "Fish TTS stream failed");
      try {
        reply.raw.end();
      } catch {
        // Response may already be closed.
      }
    }
  });
};
