import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/db/prisma";

const swipeBodySchema = z.object({
  characterId: z.string().min(1),
  decision: z.enum(["liked", "rejected"])
});

export const swipeRoutes: FastifyPluginAsync = async (app) => {
  app.post("/swipes", async (request, reply) => {
    const parsed = swipeBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const character = await prisma.character.findFirst({
      where: { id: parsed.data.characterId, isActive: true },
      select: { id: true }
    });
    if (!character) {
      return reply.notFound("Character not found");
    }

    const swipe = await prisma.swipe.upsert({
      where: {
        userId_characterId: {
          userId: request.user.id,
          characterId: parsed.data.characterId
        }
      },
      update: { decision: parsed.data.decision },
      create: {
        userId: request.user.id,
        characterId: parsed.data.characterId,
        decision: parsed.data.decision
      }
    });

    return { swipe };
  });

  app.get("/matches", async (request) => {
    const liked = await prisma.swipe.findMany({
      where: { userId: request.user.id, decision: "liked" },
      include: {
        character: true,
        user: false
      },
      orderBy: { updatedAt: "desc" }
    });

    return {
      items: liked.map((item) => ({
        characterId: item.character.id,
        character: item.character,
        matchedAt: item.updatedAt
      }))
    };
  });
};
