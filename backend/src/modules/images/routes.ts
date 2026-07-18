import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/db/prisma";
import { env } from "../../lib/env";
import { parsePositiveInt } from "../../lib/pagination";
import { ensureMediaBucket, referenceStoragePath } from "../../lib/storage/supabase-storage";

const registerReferencesBodySchema = z.object({
  characterId: z.string().min(1),
  references: z
    .array(
      z.object({
        fileName: z.string().min(1),
        mimeType: z.string().min(1).default("image/png"),
        description: z.string().max(500).optional(),
      })
    )
    .min(1)
    .max(5),
});

function requireAdminKey(request: FastifyRequest, reply: FastifyReply): boolean {
  const adminHeader = request.headers["x-admin-key"];
  if (adminHeader !== env.ADMIN_API_KEY) {
    void reply.unauthorized("Invalid x-admin-key");
    return false;
  }
  return true;
}

export const imageAdminRoutes: FastifyPluginAsync = async (app) => {
  app.post("/admin/images/setup-bucket", async (request, reply) => {
    if (!requireAdminKey(request, reply)) return reply;
    const result = await ensureMediaBucket();
    return { ok: true, bucket: env.SUPABASE_MEDIA_BUCKET, created: result.created };
  });

  /**
   * Registers reference sheets already uploaded to
   * characters/{characterId}/references/{fileName} in the media bucket.
   */
  app.post("/admin/images/references", async (request, reply) => {
    if (!requireAdminKey(request, reply)) return reply;

    const parsed = registerReferencesBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const character = await prisma.character.findUnique({
      where: { id: parsed.data.characterId },
      select: { id: true },
    });
    if (!character) {
      return reply.notFound("Character not found");
    }

    const assets = [];
    for (const reference of parsed.data.references) {
      const storagePath = referenceStoragePath(character.id, reference.fileName);
      const asset = await prisma.characterImageAsset.upsert({
        where: { storagePath },
        update: {
          isActive: true,
          mimeType: reference.mimeType,
          description: reference.description,
        },
        create: {
          characterId: character.id,
          kind: "reference",
          storagePath,
          mimeType: reference.mimeType,
          description: reference.description,
        },
      });
      assets.push(asset);
    }

    return { ok: true, assets };
  });

  app.get("/admin/images/assets", async (request, reply) => {
    if (!requireAdminKey(request, reply)) return reply;

    const query = request.query as Record<string, unknown>;
    const characterId = typeof query.characterId === "string" ? query.characterId : undefined;
    const limit = parsePositiveInt(query.limit, 50, 200);

    const assets = await prisma.characterImageAsset.findMany({
      where: characterId ? { characterId } : undefined,
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    return { items: assets };
  });

  app.post("/admin/images/assets/:id/deactivate", async (request, reply) => {
    if (!requireAdminKey(request, reply)) return reply;

    const { id } = request.params as { id: string };
    try {
      const asset = await prisma.characterImageAsset.update({
        where: { id },
        data: { isActive: false, isReusable: false },
      });
      return { ok: true, asset };
    } catch {
      return reply.notFound("Asset not found");
    }
  });

  app.get("/admin/images/requests", async (request, reply) => {
    if (!requireAdminKey(request, reply)) return reply;

    const query = request.query as Record<string, unknown>;
    const statusFilter =
      typeof query.status === "string" &&
      ["queued", "processing", "ready", "rejected", "failed"].includes(query.status)
        ? (query.status as "queued" | "processing" | "ready" | "rejected" | "failed")
        : undefined;
    const limit = parsePositiveInt(query.limit, 50, 200);

    const requests = await prisma.imageGenerationRequest.findMany({
      where: statusFilter ? { status: statusFilter } : undefined,
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    return { items: requests };
  });

  /**
   * Requeues a failed request. generationReservedAt is preserved so the retry
   * never double-charges the user's quota.
   */
  app.post("/admin/images/requests/:id/retry", async (request, reply) => {
    if (!requireAdminKey(request, reply)) return reply;

    const { id } = request.params as { id: string };
    const existing = await prisma.imageGenerationRequest.findUnique({ where: { id } });
    if (!existing) {
      return reply.notFound("Image request not found");
    }
    if (existing.status !== "failed") {
      return reply.badRequest(`Only failed requests can be retried (status: ${existing.status})`);
    }

    const updated = await prisma.imageGenerationRequest.update({
      where: { id },
      data: { status: "queued", leasedUntil: null, attemptCount: 0, errorCode: null },
    });

    if (existing.assistantMessageId) {
      await prisma.message.update({
        where: { id: existing.assistantMessageId },
        data: { mediaStatus: "pending" },
      });
    }

    return { ok: true, request: updated };
  });
};
