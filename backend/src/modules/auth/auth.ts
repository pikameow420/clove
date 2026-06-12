import type { FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { prisma } from "../../lib/db/prisma";
import { extractBearerToken, verifySupabaseAccessToken } from "./verify-supabase-jwt";

type AuthUser = {
  id: string;
  externalId: string;
};

async function resolveOrCreateUser(externalId: string): Promise<string> {
  const user = await prisma.user.upsert({
    where: { externalId },
    update: {},
    create: { externalId },
    select: { id: true },
  });

  return user.id;
}

export const authPlugin = fp(async (app) => {
  app.decorateRequest("user", {
    getter(this: FastifyRequest): AuthUser {
      if (!this._authUser) {
        throw new Error("User not authenticated");
      }
      return this._authUser;
    },
    setter(this: FastifyRequest, value: AuthUser) {
      this._authUser = value;
    },
  });

  app.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.url.startsWith("/health") || request.url.startsWith("/characters/admin/import")) {
      return;
    }

    const token = extractBearerToken(request.headers.authorization);
    if (!token) {
      return reply.unauthorized("Missing Authorization: Bearer <token> header");
    }

    let externalId: string;
    try {
      externalId = await verifySupabaseAccessToken(token);
    } catch {
      return reply.unauthorized("Invalid or expired access token");
    }

    const userId = await resolveOrCreateUser(externalId);
    request.user = { id: userId, externalId };
  });
});
