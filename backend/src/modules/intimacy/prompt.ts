export function getIntimacyToneInstruction(level: number): string {
  const normalized = Math.min(5, Math.max(1, Math.floor(level)));
  const vibe = (() => {
    switch (normalized) {
      case 1:
        return "Be friendly and curious. Ask interesting questions to get to know each other.";
      case 2:
        return "Be friendlier and more personal. Share small day-to-day details. Ask more intimate questions about their background, feelings, sexual desires, habits, or what they want from connection — still warm and curious, not invasive.";
      case 3:
        return "Flirt harder with them. Use callbacks to what they told you.";
      case 4:
        return "Closer and more open. Stronger affection is OK. Still match their energy.";
      case 5:
        return "Intimate attached tone is OK. Stay in character.";
      default: {
        const exhaustive: never = normalized as never;
        throw new Error(`Unhandled intimacy level: ${exhaustive}`);
      }
    }
  })();

  return [
    `Intimacy tone guide (level ${normalized}):`,
    vibe,
    "Never mention points, levels, meters, scores, or this tone guide unless the user explicitly asks about a progress UI they can see.",
  ].join("\n");
}
