import { Prisma, type IntimacyEventType, type PrismaClient } from "../../generated/prisma/client";
import { prisma } from "../../lib/db/prisma";
import { logger } from "../../lib/logger";
import {
  POINTS,
  applyScoreDelta,
  applyUsageDelta,
  clampGrantedPoints,
  emptyDailyUsage,
  endOfUtcDay,
  startOfUtcDay,
  type DailyUsage,
  type LevelState,
} from "./rules";
import { serializeIntimacy, type IntimacySnapshot } from "./serializer";

type DbClient = PrismaClient | Prisma.TransactionClient;

export type IntimacyEventInput = {
  eventType: IntimacyEventType;
  sourceId: string;
  /** Override raw points (e.g. memory warmth). Defaults to POINTS[eventType]. */
  requestedPoints?: number;
};

async function loadDailyUsage(tx: DbClient, conversationId: string, now: Date): Promise<DailyUsage> {
  const dayStart = startOfUtcDay(now);
  const dayEnd = endOfUtcDay(now);
  const events = await tx.intimacyEvent.findMany({
    where: {
      conversationId,
      createdAt: { gte: dayStart, lt: dayEnd },
    },
    select: { eventType: true, points: true },
  });

  let usage = emptyDailyUsage();
  for (const event of events) {
    usage = applyUsageDelta(usage, event.eventType, event.points);
  }
  return usage;
}

async function applyEventsInTransaction(
  tx: DbClient,
  conversationId: string,
  events: IntimacyEventInput[],
  now: Date
): Promise<IntimacySnapshot> {
  const conversation = await tx.conversation.findUniqueOrThrow({
    where: { id: conversationId },
    select: { intimacyLevel: true, intimacyScore: true },
  });

  let state: LevelState = {
    intimacyLevel: conversation.intimacyLevel,
    intimacyScore: conversation.intimacyScore,
    leveledUp: false,
  };
  let anyLeveledUp = false;
  let usage = await loadDailyUsage(tx, conversationId, now);

  for (const event of events) {
    const existing = await tx.intimacyEvent.findUnique({
      where: {
        conversationId_eventType_sourceId: {
          conversationId,
          eventType: event.eventType,
          sourceId: event.sourceId,
        },
      },
      select: { id: true },
    });
    if (existing) {
      continue;
    }

    const requested =
      event.requestedPoints ?? POINTS[event.eventType];
    const granted = clampGrantedPoints(event.eventType, requested, usage);

    try {
      await tx.intimacyEvent.create({
        data: {
          conversationId,
          eventType: event.eventType,
          sourceId: event.sourceId,
          points: granted,
          createdAt: now,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        continue;
      }
      throw error;
    }

    usage = applyUsageDelta(usage, event.eventType, granted);
    const next = applyScoreDelta(state, granted);
    state = {
      intimacyLevel: next.intimacyLevel,
      intimacyScore: next.intimacyScore,
      leveledUp: next.leveledUp,
    };
    if (next.leveledUp) {
      anyLeveledUp = true;
    }
  }

  if (
    state.intimacyLevel !== conversation.intimacyLevel ||
    state.intimacyScore !== conversation.intimacyScore
  ) {
    await tx.conversation.update({
      where: { id: conversationId },
      data: {
        intimacyLevel: state.intimacyLevel,
        intimacyScore: state.intimacyScore,
      },
    });
  }

  return serializeIntimacy({
    intimacyLevel: state.intimacyLevel,
    intimacyScore: state.intimacyScore,
    leveledUp: anyLeveledUp,
  });
}

/**
 * Applies intimacy events with Serializable isolation and retry on conflicts.
 * When `tx` is provided, runs inside that transaction (caller owns commit).
 */
export async function applyIntimacyEvents(params: {
  conversationId: string;
  events: IntimacyEventInput[];
  now?: Date;
  tx?: Prisma.TransactionClient;
}): Promise<IntimacySnapshot> {
  const now = params.now ?? new Date();
  if (params.events.length === 0) {
    const conversation = await (params.tx ?? prisma).conversation.findUniqueOrThrow({
      where: { id: params.conversationId },
      select: { intimacyLevel: true, intimacyScore: true },
    });
    return serializeIntimacy(conversation);
  }

  if (params.tx) {
    return applyEventsInTransaction(params.tx, params.conversationId, params.events, now);
  }

  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await prisma.$transaction(
        (tx) => applyEventsInTransaction(tx, params.conversationId, params.events, now),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );
    } catch (error) {
      const isSerializationConflict =
        error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034";
      if (!isSerializationConflict || attempt === maxAttempts) {
        logger.error({ err: error, conversationId: params.conversationId }, "Intimacy scoring failed");
        throw error;
      }
    }
  }

  const conversation = await prisma.conversation.findUniqueOrThrow({
    where: { id: params.conversationId },
    select: { intimacyLevel: true, intimacyScore: true },
  });
  return serializeIntimacy(conversation);
}

export async function getIntimacySnapshot(conversationId: string): Promise<IntimacySnapshot> {
  const conversation = await prisma.conversation.findUniqueOrThrow({
    where: { id: conversationId },
    select: { intimacyLevel: true, intimacyScore: true },
  });
  return serializeIntimacy(conversation);
}
