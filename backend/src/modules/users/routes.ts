import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/db/prisma";

const pushTokenBodySchema = z.object({
  token: z.string().min(1),
});

export const userRoutes: FastifyPluginAsync = async (app) => {
  app.post("/users/push-token", async (request, reply) => {
    const parsed = pushTokenBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    await prisma.user.update({
      where: { id: request.user.id },
      data: { expoPushToken: parsed.data.token },
    });

    return { ok: true };
  });

  app.delete("/users/push-token", async (request) => {
    await prisma.user.update({
      where: { id: request.user.id },
      data: { expoPushToken: null },
    });

    return { ok: true };
  });
};
