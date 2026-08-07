import type { FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { prisma } from "../../lib/db/prisma";
import { extractBearerToken, verifySupabaseAccessToken } from "./verify-supabase-jwt";

type AuthUser = {
  id: string;
  externalId: string;
};

type ResolvedUser = {
  id: string;
  adultConfirmedAt: Date | null;
};

async function resolveOrCreateUser(externalId: string): Promise<ResolvedUser> {
  return prisma.user.upsert({
    where: { externalId },
    update: {},
    create: { externalId },
    select: { id: true, adultConfirmedAt: true },
  });
}

function isPublicRoute(url: string): boolean {
  return (
    url.startsWith("/health") ||
    url.startsWith("/characters/admin/import") ||
    url.startsWith("/admin/")
  );
}

function isAdultConfirmationExempt(url: string): boolean {
  return url.startsWith("/users/adult-confirmation");
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
    if (isPublicRoute(request.url)) {
      return;
    }

    // The TTS stream endpoint is fetched by the native audio player, which
    // cannot set an Authorization header. It carries the access token as a
    // `token` query param instead. Header auth remains the default for all
    // other routes.
    const queryToken =
      typeof (request.query as Record<string, unknown>)?.token === "string"
        ? ((request.query as Record<string, unknown>).token as string)
        : null;
    const token = extractBearerToken(request.headers.authorization) ?? queryToken;
    if (!token) {
      return reply.unauthorized("Missing Authorization: Bearer <token> header");
    }

    let externalId: string;
    try {
      externalId = await verifySupabaseAccessToken(token);
    } catch {
      return reply.unauthorized("Invalid or expired access token");
    }

    const user = await resolveOrCreateUser(externalId);
    request.user = { id: user.id, externalId };

    if (!user.adultConfirmedAt && !isAdultConfirmationExempt(request.url)) {
      return reply.code(403).send({
        error: "ADULT_CONFIRMATION_REQUIRED",
        message:
          'Confirm you are at least 18 years old via POST /users/adult-confirmation with { "dateOfBirth": "YYYY-MM-DD" }',
      });
    }
  });
});
