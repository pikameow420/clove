import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { env, fishTtsEnabled } from "../../lib/env";
import { synthesizeFishSpeech } from "./fish-client";

const bodySchema = z.object({
  text: z.string().trim().min(1).max(env.FISH_TTS_MAX_CHARS),
  voiceKey: z.string().trim().min(1).max(64)
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
      const result = await synthesizeFishSpeech({
        voiceKey: parsed.data.voiceKey,
        text: parsed.data.text
      });

      return {
        contentType: result.contentType,
        cached: result.cached,
        audioBase64: result.audio.toString("base64")
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "TTS failed";
      if (message.startsWith("Unknown voiceKey")) {
        return reply.code(400).send({ error: "UNKNOWN_VOICE", message });
      }
      request.log.error({ err: error }, "Fish TTS synthesis failed");
      return reply.code(502).send({ error: "TTS_UPSTREAM", message: "Could not synthesize speech" });
    }
  });
};
