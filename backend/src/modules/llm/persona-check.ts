import type { Character } from "../../generated/prisma/client";

const DRIFT_PATTERNS = [/as an ai/i, /as a language model/i, /i cannot roleplay/i, /i am not .*character/i];

export function breaksPersona(character: Character, response: string): boolean {
  const text = response.trim();
  if (!text) {
    return true;
  }

  if (DRIFT_PATTERNS.some((pattern) => pattern.test(text))) {
    return true;
  }

  const mentionsName = new RegExp(character.name, "i").test(text);
  const thirdPersonDeflection = /\b(the character|this character)\b/i.test(text);
  return thirdPersonDeflection && !mentionsName;
}
