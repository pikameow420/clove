/**
 * Splits a character reply into spoken dialogue and scene narration.
 *
 * Models write narration with asterisks by convention (*she leans in*), which
 * is what the roleplay prompt asks for. The client renders narration as a
 * centered italic block instead of a chat bubble, so the split has to happen
 * server side and be stored alongside the message.
 */

export type RoleplaySegmentType = "narration" | "dialogue";

export type RoleplaySegment = {
  type: RoleplaySegmentType;
  text: string;
};

/**
 * Asterisk spans shorter than this, or without a space, are treated as word
 * emphasis (*really*) rather than a scene beat, and stay inline as dialogue.
 */
const MIN_NARRATION_LENGTH = 4;

const ASTERISK_SPAN = /\*{1,2}([^*]+)\*{1,2}/g;

const WRAPPING_QUOTES: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ["\u201c", "\u201d"],
  ["'", "'"]
];

function isNarration(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length >= MIN_NARRATION_LENGTH && /\s/.test(trimmed);
}

/**
 * Models habitually wrap spoken lines in quotes. In a texting UI the quotes
 * read as noise, so a fully wrapped segment is unwrapped.
 */
function stripWrappingQuotes(text: string): string {
  const trimmed = text.trim();
  for (const [open, close] of WRAPPING_QUOTES) {
    if (trimmed.length > 2 && trimmed.startsWith(open) && trimmed.endsWith(close)) {
      const inner = trimmed.slice(open.length, -close.length).trim();
      // Bail out when the quotes wrap several separate quoted lines.
      if (!inner.includes(open) && !inner.includes(close)) {
        return inner;
      }
    }
  }
  return trimmed;
}

function cleanDialogue(text: string): string {
  return stripWrappingQuotes(text.replace(/\*/g, " ").replace(/[ \t]+/g, " ").trim());
}

function pushSegment(segments: RoleplaySegment[], type: RoleplaySegmentType, raw: string): void {
  const text = type === "narration" ? raw.trim() : cleanDialogue(raw);
  if (!text) {
    return;
  }

  // Narration split across several asterisk spans reads as one scene beat.
  const previous = segments[segments.length - 1];
  if (previous && previous.type === type) {
    previous.text = `${previous.text} ${text}`;
    return;
  }

  segments.push({ type, text });
}

export function parseRoleplaySegments(content: string): RoleplaySegment[] {
  const segments: RoleplaySegment[] = [];
  let cursor = 0;

  ASTERISK_SPAN.lastIndex = 0;
  let match = ASTERISK_SPAN.exec(content);

  while (match !== null) {
    const inner = match[1] ?? "";

    if (isNarration(inner)) {
      pushSegment(segments, "dialogue", content.slice(cursor, match.index));
      pushSegment(segments, "narration", inner);
      cursor = match.index + match[0].length;
    }
    // Emphasis spans are left in place; cleanDialogue drops the asterisks.

    match = ASTERISK_SPAN.exec(content);
  }

  pushSegment(segments, "dialogue", content.slice(cursor));

  return segments;
}

export function hasNarration(segments: RoleplaySegment[]): boolean {
  return segments.some((segment) => segment.type === "narration");
}

/**
 * Plain text for push notifications and the chat list preview, where a scene
 * description without its bubble reads as broken. Falls back to narration only
 * when the turn was pure scene setting.
 */
export function segmentsToPreviewText(segments: RoleplaySegment[]): string {
  const dialogue = segments
    .filter((segment) => segment.type === "dialogue")
    .map((segment) => segment.text)
    .join(" ")
    .trim();

  if (dialogue) {
    return dialogue;
  }

  return segments
    .map((segment) => segment.text)
    .join(" ")
    .trim();
}

/** Convenience for stored rows that predate segments. */
export function previewTextFromContent(content: string): string {
  return segmentsToPreviewText(parseRoleplaySegments(content));
}

const SEGMENT_TYPES: readonly RoleplaySegmentType[] = ["narration", "dialogue"];

/** Revives segments read back from the Message.segments JSON column. */
export function parseStoredSegments(raw: unknown): RoleplaySegment[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }

  const segments: RoleplaySegment[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const { type, text } = entry as { type?: unknown; text?: unknown };
    if (
      typeof text === "string" &&
      text.trim().length > 0 &&
      SEGMENT_TYPES.includes(type as RoleplaySegmentType)
    ) {
      segments.push({ type: type as RoleplaySegmentType, text });
    }
  }

  return segments.length > 0 ? segments : null;
}
