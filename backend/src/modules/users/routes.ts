import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/db/prisma";
import { logger } from "../../lib/logger";
import { getSupabaseAdminClient } from "../../lib/supabase-admin";
import { getImageUsage } from "../images/image-reply-service";
import { isAtLeast18, parseDateOfBirth } from "./age";

const pushTokenBodySchema = z.object({
  token: z.string().min(1),
});

const adultConfirmationBodySchema = z.object({
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"),
});

export const userRoutes: FastifyPluginAsync = async (app) => {
  app.delete("/users/me", async (request, reply) => {
    const { id, externalId } = request.user;

    try {
      await prisma.user.delete({ where: { id } });
    } catch (error) {
      logger.error({ err: error, userId: id, externalId }, "Failed to delete Prisma user");
      return reply.code(500).send({
        error: "DELETE_FAILED",
        message: "Could not delete account data",
      });
    }

    try {
      const admin = getSupabaseAdminClient();
      const { error } = await admin.auth.admin.deleteUser(externalId);
      if (error) {
        throw error;
      }
    } catch (error) {
      logger.error(
        { err: error, userId: id, externalId },
        "Prisma user deleted but Supabase auth delete failed",
      );
      return reply.code(502).send({
        error: "AUTH_DELETE_FAILED",
        message:
          "App data was removed but the login account could not be deleted. Please try again or contact support.",
      });
    }

    return { ok: true };
  });

  app.post("/users/adult-confirmation", async (request, reply) => {
    const parsed = adultConfirmationBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "INVALID_BODY",
        message: 'Send { "dateOfBirth": "YYYY-MM-DD" } to confirm you are at least 18 years old',
      });
    }

    const dateOfBirth = parseDateOfBirth(parsed.data.dateOfBirth);
    if (!dateOfBirth) {
      return reply.code(400).send({
        error: "INVALID_DATE_OF_BIRTH",
        message: "dateOfBirth must be a real calendar date in YYYY-MM-DD format",
      });
    }

    const now = new Date();
    if (dateOfBirth.getTime() > now.getTime()) {
      return reply.code(400).send({
        error: "INVALID_DATE_OF_BIRTH",
        message: "dateOfBirth cannot be in the future",
      });
    }

    if (!isAtLeast18(dateOfBirth, now)) {
      return reply.code(403).send({
        error: "UNDERAGE",
        message: "You must be at least 18 years old to use this app",
      });
    }

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: request.user.id },
      select: { adultConfirmedAt: true, dateOfBirth: true },
    });

    if (user.adultConfirmedAt) {
      return { ok: true, alreadyConfirmed: true };
    }

    await prisma.user.update({
      where: { id: request.user.id },
      data: {
        dateOfBirth,
        adultConfirmedAt: now,
      },
    });

    return { ok: true, alreadyConfirmed: false };
  });

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

  app.get("/users/image-usage", async (request) => {
    return getImageUsage(request.user.id);
  });
};
