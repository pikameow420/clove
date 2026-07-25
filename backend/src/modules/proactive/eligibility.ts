import type { Character, Conversation, Message, ProactiveTrigger } from "../../generated/prisma/client";
import { prisma } from "../../lib/db/prisma";
import { env } from "../../lib/env";
import { buildProactiveLlmMessages } from "./prompt-builder";
import { llmChat } from "../llm/provider";
import { parseRoleplaySegments, type RoleplaySegment } from "../llm/roleplay";
import { persistAssistantMessage } from "../conversations/assistant-message";

export type ProactiveCandidate = {
  userId: string;
  characterId: string;
  conversationId: string;
  trigger: ProactiveTrigger;
  score: number;
  idleHours?: number;
  character: Character;
  conversation: Conversation;
  recentMessages: Message[];
};

export async function countProactiveMessagesLast24h(userId: string): Promise<number> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return prisma.message.count({
    where: {
      source: "assistant_proactive",
      createdAt: { gte: since },
      conversation: { userId }
    }
  });
}

export async function countUserMessages(conversationId: string): Promise<number> {
  return prisma.message.count({
    where: { conversationId, role: "user" }
  });
}

function isInBackoff(conversation: Conversation, now: Date): boolean {
  return conversation.proactiveBackoffUntil !== null && conversation.proactiveBackoffUntil > now;
}

export async function findBestProactiveCandidateForUser(userId: string, now = new Date()): Promise<ProactiveCandidate | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { proactiveEnabled: true }
  });
  if (!user?.proactiveEnabled) {
    return null;
  }

  const proactiveCount = await countProactiveMessagesLast24h(userId);
  if (proactiveCount >= env.PROACTIVE_DAILY_CAP) {
    return null;
  }

  const likes = await prisma.swipe.findMany({
    where: { userId, decision: "liked" },
    include: {
      character: true
    }
  });

  let best: ProactiveCandidate | null = null;

  for (const swipe of likes) {
    if (!swipe.character.isActive) {
      continue;
    }

    const conversation = await prisma.conversation.findUnique({
      where: {
        userId_characterId: {
          userId,
          characterId: swipe.characterId
        }
      }
    });

    // Opening message covers the first ping; skip post_match proactive entirely.
    if (!conversation) {
      continue;
    }

    if (isInBackoff(conversation, now)) {
      continue;
    }

    if (conversation.consecutiveProactiveCount >= 2) {
      continue;
    }

    const userMessageCount = await countUserMessages(conversation.id);
    if (userMessageCount === 0) {
      continue;
    }

    const lastUserAt =
      conversation.lastUserMessageAt ??
      (
        await prisma.message.findFirst({
          where: { conversationId: conversation.id, role: "user" },
          orderBy: { createdAt: "desc" },
          select: { createdAt: true }
        })
      )?.createdAt;

    if (!lastUserAt) {
      continue;
    }

    const idleMs = now.getTime() - lastUserAt.getTime();
    if (idleMs >= env.PROACTIVE_IDLE_MS) {
      const idleHours = idleMs / 3_600_000;
      const candidate: ProactiveCandidate = {
        userId,
        characterId: swipe.characterId,
        conversationId: conversation.id,
        trigger: "idle",
        score: idleHours * 5,
        idleHours,
        character: swipe.character,
        conversation,
        recentMessages: await prisma.message.findMany({
          where: { conversationId: conversation.id },
          orderBy: { createdAt: "asc" },
          take: env.MAX_CONTEXT_MESSAGES
        })
      };
      if (!best || candidate.score > best.score) {
        best = candidate;
      }
    }
  }

  return best;
}

export async function findProactiveCandidatesForTick(now = new Date()): Promise<ProactiveCandidate[]> {
  const users = await prisma.user.findMany({
    where: {
      proactiveEnabled: true,
      swipes: { some: { decision: "liked" } }
    },
    select: { id: true }
  });

  const candidates: ProactiveCandidate[] = [];
  for (const user of users) {
    const candidate = await findBestProactiveCandidateForUser(user.id, now);
    if (candidate) {
      candidates.push(candidate);
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, env.PROACTIVE_MAX_PER_TICK);
}

async function generateProactiveReply(params: {
  character: Character;
  recentMessages: Message[];
  summary: string | null;
  trigger: ProactiveTrigger;
  idleHours?: number;
  intimacyLevel?: number;
}): Promise<{ content: string; tokenCount: number | null; segments: RoleplaySegment[] | null }> {
  const llmMessages = buildProactiveLlmMessages(params);
  const reply = await llmChat(llmMessages);
  const content = reply.content.replace(/[\u2014\u2013]/g, ",");
  const segments = env.ROLEPLAY_ENABLED ? parseRoleplaySegments(content) : [];
  return {
    content,
    tokenCount: reply.tokenCount,
    segments: segments.some((segment) => segment.type === "narration") ? segments : null
  };
}

export async function sendProactiveMessage(candidate: ProactiveCandidate): Promise<Message> {
  const { getOrCreateConversation } = await import("../conversations/service");

  const conversation =
    candidate.conversationId.length > 0
      ? candidate.conversation
      : await getOrCreateConversation(candidate.userId, candidate.characterId);

  const recentMessages =
    candidate.recentMessages.length > 0
      ? candidate.recentMessages
      : await prisma.message.findMany({
          where: { conversationId: conversation.id },
          orderBy: { createdAt: "asc" },
          take: env.MAX_CONTEXT_MESSAGES
        });

  const intimacyLevel =
    "intimacyLevel" in conversation && typeof conversation.intimacyLevel === "number"
      ? conversation.intimacyLevel
      : 1;

  const reply = await generateProactiveReply({
    character: candidate.character,
    recentMessages,
    summary: conversation.summary,
    trigger: candidate.trigger,
    idleHours: candidate.idleHours,
    intimacyLevel
  });

  const persisted = await persistAssistantMessage({
    conversationId: conversation.id,
    userId: candidate.userId,
    characterId: candidate.characterId,
    characterName: candidate.character.name,
    content: reply.content,
    segments: reply.segments,
    tokenCount: reply.tokenCount,
    source: "assistant_proactive",
    proactiveTrigger: candidate.trigger,
    recentMessages,
    existingSummary: conversation.summary,
    latestAssistantReply: reply.content
  });

  return persisted.message;
}

export type ProactiveDryRunResult = {
  userId: string;
  characterId: string;
  characterName: string;
  conversationId: string | null;
  trigger: ProactiveTrigger;
  score: number;
  reason: string;
};

export async function dryRunProactiveTick(now = new Date()): Promise<ProactiveDryRunResult[]> {
  const candidates = await findProactiveCandidatesForTick(now);
  return candidates.map((candidate) => ({
    userId: candidate.userId,
    characterId: candidate.characterId,
    characterName: candidate.character.name,
    conversationId: candidate.conversationId || null,
    trigger: candidate.trigger,
    score: candidate.score,
    reason:
      candidate.trigger === "idle"
        ? `Idle check-in: ~${Math.round(candidate.idleHours ?? 0)}h since last user message`
        : "Skipped (post_match disabled; opener handles first ping)"
  }));
}
