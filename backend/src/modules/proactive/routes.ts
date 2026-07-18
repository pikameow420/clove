import type { FastifyPluginAsync } from "fastify";
import { env } from "../../lib/env";
import { dryRunProactiveTick, findProactiveCandidatesForTick, sendProactiveMessage } from "./eligibility";

export const proactiveAdminRoutes: FastifyPluginAsync = async (app) => {
  app.post("/admin/jobs/proactive-run", async (request, reply) => {
    const adminHeader = request.headers["x-admin-key"];
    if (adminHeader !== env.ADMIN_API_KEY) {
      return reply.unauthorized("Invalid x-admin-key");
    }

    const query = request.query as Record<string, unknown>;
    const dryRun = query.dryRun === "true";

    if (dryRun) {
      const preview = await dryRunProactiveTick();
      return { dryRun: true, candidates: preview };
    }

    const candidates = await findProactiveCandidatesForTick();
    const results = [];

    for (const candidate of candidates) {
      try {
        const message = await sendProactiveMessage(candidate);
        results.push({
          status: "sent",
          userId: candidate.userId,
          characterId: candidate.characterId,
          conversationId: message.conversationId,
          trigger: candidate.trigger,
          messageId: message.id
        });
      } catch (error) {
        results.push({
          status: "failed",
          userId: candidate.userId,
          characterId: candidate.characterId,
          trigger: candidate.trigger,
          error: error instanceof Error ? error.message : "Unknown error"
        });
      }
    }

    return { dryRun: false, processed: results.length, results };
  });
};
