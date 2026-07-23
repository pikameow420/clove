const DEFAULT_OPENER = (name: string) =>
  `Hey, it's ${name}. Glad we matched. What made you swipe right?`;

export function pickOpeningMessage(raw: unknown, characterName: string): string {
  if (!Array.isArray(raw) || raw.length === 0) {
    return DEFAULT_OPENER(characterName);
  }

  const messages = raw
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());

  if (messages.length === 0) {
    return DEFAULT_OPENER(characterName);
  }

  const index = Math.floor(Math.random() * messages.length);
  return messages[index]!;
}
