import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/db/prisma";
import { parsePositiveInt } from "../../lib/pagination";
import { env } from "../../lib/env";
import { characterProfileSchema } from "./profile";

const importBodySchema = z.object({
  characters: z
    .array(
      z.object({
        name: z.string().min(1),
        imageUrl: z.string().min(1),
        about: z.string().min(1),
        gender: z.string().optional(),
        interests: z.array(z.string()).default([]),
        profile: characterProfileSchema,
        personaSystemPrompt: z.string().min(1),
        personaFacts: z.array(z.string()).default([])
      })
    )
    .min(1)
});

export const characterRoutes: FastifyPluginAsync = async (app) => {
  app.get("/characters", async (request) => {
    const query = request.query as Record<string, unknown>;
    const limit = parsePositiveInt(query.limit, 20, 100);
    const cursor = typeof query.cursor === "string" ? query.cursor : undefined;
    const excludeSwiped = query.excludeSwiped !== "false";

    const whereClause = excludeSwiped
      ? {
          isActive: true,
          swipes: {
            none: {
              userId: request.user.id
            }
          }
        }
      : { isActive: true };

    const results = await prisma.character.findMany({
      where: whereClause,
      orderBy: { createdAt: "desc" },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
    });

    const hasNextPage = results.length > limit;
    const items = hasNextPage ? results.slice(0, limit) : results;
    const nextCursor = hasNextPage ? items[items.length - 1]?.id : null;

    return { items, pageInfo: { hasNextPage, nextCursor } };
  });

  app.get("/characters/:id", async (request, reply) => {
    const { id } = request.params as { id: string };

    const character = await prisma.character.findFirst({
      where: {
        id,
        isActive: true,
        swipes: {
          some: {
            userId: request.user.id,
            decision: "liked"
          }
        }
      }
    });

    if (!character) {
      return reply.notFound("Character not found");
    }

    return { character };
  });

  app.post("/characters/admin/import", async (request, reply) => {
    const adminHeader = request.headers["x-admin-key"];
    if (adminHeader !== env.ADMIN_API_KEY) {
      return reply.unauthorized("Invalid x-admin-key");
    }

    const parsed = importBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    await prisma.$transaction(
      parsed.data.characters.map((character) =>
        prisma.character.upsert({
          where: { name: character.name },
          update: {
            imageUrl: character.imageUrl,
            about: character.about,
            gender: character.gender,
            interests: character.interests,
            profile: character.profile,
            personaSystemPrompt: character.personaSystemPrompt,
            personaFacts: character.personaFacts,
            isActive: true
          },
          create: {
            name: character.name,
            imageUrl: character.imageUrl,
            about: character.about,
            gender: character.gender,
            interests: character.interests,
            profile: character.profile,
            personaSystemPrompt: character.personaSystemPrompt,
            personaFacts: character.personaFacts
          }
        })
      )
    );

    return { imported: parsed.data.characters.length };
  });
};
