import type { FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { prisma } from "../../lib/db/prisma";

const USER_HEADER = "x-user-id";

async function resolveOrCreateUser(externalId: string): Promise<string> {
  const user = await prisma.user.upsert({
    where: { externalId },
    update: {},
    create: { externalId },
    select: { id: true }
  });

  return user.id;
}

export const authPlugin = fp(async (app) => {
  app.decorateRequest("user", null);

  app.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.url.startsWith("/health") || request.url.startsWith("/characters/admin/import")) {
      return;
    }

    const externalId = request.headers[USER_HEADER] as string | undefined;
    if (!externalId || !externalId.trim()) {
      return reply.unauthorized(`Missing ${USER_HEADER} header`);
    }

    const userId = await resolveOrCreateUser(externalId.trim());
    request.setDecorator("user", { id: userId });
  });
});
