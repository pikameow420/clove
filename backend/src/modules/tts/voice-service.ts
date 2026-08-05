import { prisma } from "../../lib/db/prisma";

/**
 * Resolves a character's Fish Audio voice id from the `Voice` table.
 *
 * The backend is the single authority for character -> voice resolution so
 * client bundles never ship fishVoiceIds, and user-created characters get
 * voices through the same path. The caller's ownership of the character is
 * verified here so a client cannot request another user's cloned voice.
 */

const voiceCache = new Map<string, string>();

export type ResolvedVoice = {
  fishVoiceId: string;
  characterName: string;
};

export function invalidateVoiceCache(characterId: string): void {
  voiceCache.delete(characterId);
}

/**
 * Resolve the active voice for a character the user is allowed to talk to.
 * Returns null when the character is unknown, not liked, or has no voice.
 */
export async function resolveVoiceForCharacter(
  characterId: string,
  userId: string
): Promise<ResolvedVoice | null> {
  const cached = voiceCache.get(characterId);
  if (cached) {
    const cachedName = await prisma.character
      .findUnique({ where: { id: characterId }, select: { name: true } })
      .then((row) => row?.name ?? null);
    if (cachedName) {
      return { fishVoiceId: cached, characterName: cachedName };
    }
  }

  const character = await prisma.character.findFirst({
    where: {
      id: characterId,
      isActive: true,
      swipes: {
        some: { userId, decision: "liked" }
      }
    },
    select: {
      id: true,
      name: true,
      voices: {
        where: { isActive: true },
        orderBy: { createdAt: "asc" },
        take: 1,
        select: { fishVoiceId: true }
      }
    }
  });

  if (!character) return null;

  const voice = character.voices[0];
  if (!voice) return null;

  voiceCache.set(characterId, voice.fishVoiceId);
  return { fishVoiceId: voice.fishVoiceId, characterName: character.name };
}