import type { IntimacyEventType } from "../../generated/prisma/client";

export const INTIMACY_MIN_LEVEL = 1;
export const INTIMACY_MAX_LEVEL = 5;
export const INTIMACY_SCORE_MAX = 100;
export const INTIMACY_LEVEL_UP_RESET = 10;

export const DAILY_TOTAL_CAP = 200;
export const CHAT_BUCKET_CAP = 100;
export const ANSWERED_QUESTION_MAX = 4;
export const SHARED_DAY_MAX = 1;
export const PROACTIVE_REPLY_MAX = 2;
export const PHOTO_MOMENT_MAX = 3;
export const MEMORY_WARMTH_DAILY_CAP = 20;
export const MEMORY_WARMTH_PER_REFRESH_CAP = 9;

export const PROACTIVE_REPLY_WINDOW_MS = 2 * 60 * 60 * 1000;

export const POINTS: Record<IntimacyEventType, number> = {
  user_message: 3,
  user_message_meaningful: 5,
  answered_question: 8,
  shared_day: 10,
  proactive_sent: 0,
  proactive_reply: 15,
  photo_moment_cache: 12,
  photo_moment_generated: 16,
  photo_request_accepted: 4,
  memory_warmth: 0, // computed dynamically
};

const FILLER_EXACT = new Set([
  "ok",
  "k",
  "kk",
  "lol",
  "lmao",
  "haha",
  "hahaha",
  "yes",
  "no",
  "nah",
  "yep",
  "yeah",
  "sup",
  "hi",
  "hey",
  "hello",
  "bye",
  "gn",
  "gm",
  "ty",
  "thanks",
  "np",
]);

const EMOJI_ONLY_RE =
  /^(?:[\p{Emoji_Presentation}\p{Extended_Pictographic}\uFE0F\u200D\s])+$/u;

export type MessageClass = "filler" | "regular" | "meaningful";

export function classifyUserMessage(content: string): MessageClass {
  const trimmed = content.trim();
  if (trimmed.length < 2) {
    return "filler";
  }

  const normalized = trimmed.toLowerCase().replace(/[!?.…]+$/g, "").trim();
  if (FILLER_EXACT.has(normalized)) {
    return "filler";
  }

  if (EMOJI_ONLY_RE.test(trimmed) && !/[a-zA-Z0-9]/.test(trimmed)) {
    return "filler";
  }

  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length >= 8 || trimmed.includes("?") || trimmed.length >= 40) {
    return "meaningful";
  }

  return "regular";
}

export function startOfUtcDay(date: Date = new Date()): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function utcDayKey(date: Date = new Date()): string {
  return startOfUtcDay(date).toISOString().slice(0, 10);
}

export function endOfUtcDay(date: Date = new Date()): Date {
  const start = startOfUtcDay(date);
  return new Date(start.getTime() + 24 * 60 * 60 * 1000);
}

export type CapBucket =
  | "total"
  | "chat"
  | "answered_question"
  | "shared_day"
  | "proactive_reply"
  | "photo_moment"
  | "memory_warmth";

export function bucketForEvent(eventType: IntimacyEventType): CapBucket {
  switch (eventType) {
    case "user_message":
    case "user_message_meaningful":
      return "chat";
    case "answered_question":
      return "answered_question";
    case "shared_day":
      return "shared_day";
    case "proactive_reply":
      return "proactive_reply";
    case "photo_moment_cache":
    case "photo_moment_generated":
      return "photo_moment";
    case "memory_warmth":
      return "memory_warmth";
    case "proactive_sent":
    case "photo_request_accepted":
      return "total";
    default: {
      const exhaustive: never = eventType;
      throw new Error(`Unhandled intimacy event type: ${exhaustive}`);
    }
  }
}

export function isCountCappedBucket(bucket: CapBucket): boolean {
  return (
    bucket === "answered_question" ||
    bucket === "shared_day" ||
    bucket === "proactive_reply" ||
    bucket === "photo_moment"
  );
}

export type DailyUsage = {
  totalGranted: number;
  chatGranted: number;
  memoryGranted: number;
  answeredQuestionCount: number;
  sharedDayCount: number;
  proactiveReplyCount: number;
  photoMomentCount: number;
};

export function emptyDailyUsage(): DailyUsage {
  return {
    totalGranted: 0,
    chatGranted: 0,
    memoryGranted: 0,
    answeredQuestionCount: 0,
    sharedDayCount: 0,
    proactiveReplyCount: 0,
    photoMomentCount: 0,
  };
}

/**
 * Computes granted points after bucket and total daily caps. Partial credit is OK.
 * Count-capped buckets grant either full requested points or 0 when the count is exhausted.
 */
export function clampGrantedPoints(
  eventType: IntimacyEventType,
  requested: number,
  usage: DailyUsage
): number {
  if (requested <= 0) {
    return 0;
  }

  const totalRoom = Math.max(0, DAILY_TOTAL_CAP - usage.totalGranted);
  if (totalRoom <= 0) {
    return 0;
  }

  const bucket = bucketForEvent(eventType);

  if (bucket === "answered_question" && usage.answeredQuestionCount >= ANSWERED_QUESTION_MAX) {
    return 0;
  }
  if (bucket === "shared_day" && usage.sharedDayCount >= SHARED_DAY_MAX) {
    return 0;
  }
  if (bucket === "proactive_reply" && usage.proactiveReplyCount >= PROACTIVE_REPLY_MAX) {
    return 0;
  }
  if (bucket === "photo_moment" && usage.photoMomentCount >= PHOTO_MOMENT_MAX) {
    return 0;
  }

  let capped = requested;
  if (bucket === "chat") {
    capped = Math.min(capped, Math.max(0, CHAT_BUCKET_CAP - usage.chatGranted));
  }
  if (bucket === "memory_warmth") {
    capped = Math.min(capped, Math.max(0, MEMORY_WARMTH_DAILY_CAP - usage.memoryGranted));
  }

  return Math.min(capped, totalRoom);
}

export function applyUsageDelta(
  usage: DailyUsage,
  eventType: IntimacyEventType,
  granted: number
): DailyUsage {
  const next = { ...usage };
  next.totalGranted += granted;

  const bucket = bucketForEvent(eventType);
  switch (bucket) {
    case "chat":
      next.chatGranted += granted;
      break;
    case "memory_warmth":
      next.memoryGranted += granted;
      break;
    case "answered_question":
      // Count-capped events always consume a slot once recorded (including 0-point grants).
      next.answeredQuestionCount += 1;
      break;
    case "shared_day":
      next.sharedDayCount += 1;
      break;
    case "proactive_reply":
      next.proactiveReplyCount += 1;
      break;
    case "photo_moment":
      next.photoMomentCount += 1;
      break;
    case "total":
      break;
    default: {
      const exhaustive: never = bucket;
      throw new Error(`Unhandled bucket: ${exhaustive}`);
    }
  }

  return next;
}

export type LevelState = {
  intimacyLevel: number;
  intimacyScore: number;
  leveledUp: boolean;
};

/** Applies one scoring event's granted points with at most one level-up. */
export function applyScoreDelta(state: LevelState, granted: number): LevelState {
  if (granted <= 0) {
    return {
      intimacyLevel: state.intimacyLevel,
      intimacyScore: state.intimacyScore,
      leveledUp: false,
    };
  }

  if (state.intimacyLevel >= INTIMACY_MAX_LEVEL) {
    return {
      intimacyLevel: INTIMACY_MAX_LEVEL,
      intimacyScore: Math.min(INTIMACY_SCORE_MAX, state.intimacyScore + granted),
      leveledUp: false,
    };
  }

  const nextScore = state.intimacyScore + granted;
  if (nextScore >= INTIMACY_SCORE_MAX) {
    return {
      intimacyLevel: state.intimacyLevel + 1,
      intimacyScore: INTIMACY_LEVEL_UP_RESET,
      leveledUp: true,
    };
  }

  return {
    intimacyLevel: state.intimacyLevel,
    intimacyScore: nextScore,
    leveledUp: false,
  };
}

export function memoryWarmthPoints(warmth: number, disclosure: number, reciprocity: number): number {
  const clamp = (value: number) => Math.max(0, Math.min(3, Math.floor(value)));
  return Math.min(
    MEMORY_WARMTH_PER_REFRESH_CAP,
    clamp(warmth) + clamp(disclosure) + clamp(reciprocity)
  );
}
