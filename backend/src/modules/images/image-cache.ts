import type { CharacterImageAsset } from "../../generated/prisma/client";
import { prisma } from "../../lib/db/prisma";
import { env } from "../../lib/env";
import { logger } from "../../lib/logger";
import type { ImageBrief } from "./image-intent";

type CacheCandidate = Pick<
  CharacterImageAsset,
  "id" | "sceneKey" | "tags" | "storagePath" | "mimeType" | "description"
>;

/** Conservative threshold: never send the wrong image on a weak match. */
const TAG_MATCH_THRESHOLD = 0.75;

function toTagSet(rawTags: unknown): Set<string> {
  if (!Array.isArray(rawTags)) {
    return new Set();
  }
  return new Set(rawTags.filter((tag): tag is string => typeof tag === "string"));
}

export function scoreTagSimilarity(briefTags: string[], assetTags: Set<string>): number {
  if (briefTags.length === 0 || assetTags.size === 0) {
    return 0;
  }
  const matched = briefTags.filter((tag) => assetTags.has(tag)).length;
  return matched / briefTags.length;
}

/**
 * Finds a reusable cached asset for the character. Exact normalized sceneKey
 * wins; otherwise weighted tag similarity where the mandatory scene, setting,
 * and camera tags must all match and secondary tags push the score over a
 * conservative threshold.
 */
export function selectCacheMatch(brief: ImageBrief, candidates: CacheCandidate[]): CacheCandidate | null {
  const exact = candidates.find((candidate) => candidate.sceneKey === brief.sceneKey);
  if (exact) {
    return exact;
  }

  const mandatoryTags = [brief.setting, brief.camera, brief.scene]
    .map((value) => value.toLowerCase().trim().replace(/\s+/g, "-"))
    .filter(Boolean);

  let best: { candidate: CacheCandidate; score: number } | null = null;
  for (const candidate of candidates) {
    const assetTags = toTagSet(candidate.tags);
    const mandatoryHit = mandatoryTags.every((tag) => assetTags.has(tag));
    if (!mandatoryHit) {
      continue;
    }
    const score = scoreTagSimilarity(brief.tags, assetTags);
    if (score >= TAG_MATCH_THRESHOLD && (!best || score > best.score)) {
      best = { candidate, score };
    }
  }

  return best?.candidate ?? null;
}

export async function findCachedAsset(params: {
  characterId: string;
  brief: ImageBrief;
}): Promise<CacheCandidate | null> {
  const candidates = await prisma.characterImageAsset.findMany({
    where: {
      characterId: params.characterId,
      kind: "generated",
      isActive: true,
      isReusable: true,
      moderation: "approved",
    },
    select: {
      id: true,
      sceneKey: true,
      tags: true,
      storagePath: true,
      mimeType: true,
      description: true,
    },
  });

  return selectCacheMatch(params.brief, candidates);
}

export async function recordCacheUse(assetId: string): Promise<void> {
  await prisma.characterImageAsset.update({
    where: { id: assetId },
    data: {
      lastUsedAt: new Date(),
      useCount: { increment: 1 },
    },
  });
}

/**
 * Keeps at most IMAGE_CACHE_LIMIT_PER_CHARACTER reusable generated assets by
 * demoting the least recently reused ones. Rows and storage objects are kept
 * so historical messages keep working.
 */
export async function demoteExcessCacheAssets(characterId: string): Promise<number> {
  const reusable = await prisma.characterImageAsset.findMany({
    where: {
      characterId,
      kind: "generated",
      isReusable: true,
    },
    orderBy: [{ lastUsedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
    select: { id: true },
  });

  const excess = reusable.slice(env.IMAGE_CACHE_LIMIT_PER_CHARACTER);
  if (excess.length === 0) {
    return 0;
  }

  await prisma.characterImageAsset.updateMany({
    where: { id: { in: excess.map((asset) => asset.id) } },
    data: { isReusable: false },
  });

  logger.info({ characterId, demoted: excess.length }, "Demoted excess cache assets");
  return excess.length;
}
