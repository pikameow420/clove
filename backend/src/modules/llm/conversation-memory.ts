import type { Message } from "../../generated/prisma/client";
import { logger } from "../../lib/logger";
import { chatWithOllama } from "./ollama-client";

export type ConversationMemory = {
  characterArc: string;
  relationship: string;
  openThreads: string[];
  messageCount: number;
};

const EMPTY_MEMORY: ConversationMemory = {
  characterArc: "",
  relationship: "",
  openThreads: [],
  messageCount: 0
};

const MEMORY_UPDATE_INTERVAL = 4;

export function parseMemory(raw: string | null): ConversationMemory {
  if (!raw?.trim()) {
    return { ...EMPTY_MEMORY };
  }

  try {
    const parsed = JSON.parse(raw) as Partial<ConversationMemory>;
    return {
      characterArc: typeof parsed.characterArc === "string" ? parsed.characterArc : "",
      relationship: typeof parsed.relationship === "string" ? parsed.relationship : "",
      openThreads: Array.isArray(parsed.openThreads)
        ? parsed.openThreads.filter((t): t is string => typeof t === "string" && t.trim().length > 0)
        : [],
      messageCount: typeof parsed.messageCount === "number" ? parsed.messageCount : 0
    };
  } catch {
    return {
      ...EMPTY_MEMORY,
      relationship: raw.trim()
    };
  }
}

export function serializeMemory(memory: ConversationMemory): string {
  return JSON.stringify(memory);
}

export function formatMemoryForPrompt(raw: string | null): string {
  const memory = parseMemory(raw);
  const sections: string[] = [];

  if (memory.characterArc.trim()) {
    sections.push(`Character's current arc (their own life):\n${memory.characterArc.trim()}`);
  }

  if (memory.relationship.trim()) {
    sections.push(`Relationship with this user:\n${memory.relationship.trim()}`);
  }

  if (memory.openThreads.length) {
    sections.push(`Open threads to callback when natural:\n${memory.openThreads.map((t) => `- ${t}`).join("\n")}`);
  }

  if (!sections.length) {
    return "Conversation memory: None yet. Let your personality and personal arc emerge naturally over time.";
  }

  return sections.join("\n\n");
}

function formatRecentTurns(messages: Message[]): string {
  return messages
    .slice(-8)
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n");
}

export function shouldUpdateMemory(messageCount: number, rawMemory: string | null): boolean {
  if (messageCount < 4) {
    return false;
  }

  const memory = parseMemory(rawMemory);
  return messageCount - memory.messageCount >= MEMORY_UPDATE_INTERVAL;
}

export async function updateConversationMemory(params: {
  characterName: string;
  existingMemory: string | null;
  recentMessages: Message[];
  latestUserInput: string;
  latestAssistantReply: string;
  messageCount: number;
}): Promise<string> {
  const current = parseMemory(params.existingMemory);

  const memoryPrompt = [
    {
      role: "system" as const,
      content: [
        "You maintain structured memory for a fictional character chat.",
        "Return ONLY valid JSON with this exact shape:",
        '{"characterArc":"string","relationship":"string","openThreads":["string"]}',
        "characterArc: 2-4 sentences on the CHARACTER's own ongoing life: goals, stress, wins, plans (not the user's life).",
        "relationship: 2-4 sentences on rapport with the user: tone, what they learned about the user, intimacy level.",
        "openThreads: up to 5 short bullets of unresolved topics to mention later (promises, questions, inside jokes).",
        "Merge new info with existing memory. Drop stale threads. Be concise."
      ].join("\n")
    },
    {
      role: "user" as const,
      content: [
        `Character: ${params.characterName}`,
        `Existing memory JSON: ${serializeMemory({ ...current, messageCount: 0 })}`,
        `Recent turns:\n${formatRecentTurns(params.recentMessages)}`,
        `Latest exchange:\nUser: ${params.latestUserInput}\nAssistant: ${params.latestAssistantReply}`,
        "Output updated JSON only."
      ].join("\n\n")
    }
  ];

  try {
    const result = await chatWithOllama(memoryPrompt, { temperature: 0.2, maxTokens: 400 });
    const jsonMatch = result.content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("No JSON in memory response");
    }

    const parsed = JSON.parse(jsonMatch[0]) as Partial<ConversationMemory>;
    const updated: ConversationMemory = {
      characterArc: typeof parsed.characterArc === "string" ? parsed.characterArc.trim() : current.characterArc,
      relationship: typeof parsed.relationship === "string" ? parsed.relationship.trim() : current.relationship,
      openThreads: Array.isArray(parsed.openThreads)
        ? parsed.openThreads.filter((t): t is string => typeof t === "string").slice(0, 5)
        : current.openThreads,
      messageCount: params.messageCount
    };

    return serializeMemory(updated);
  } catch (error) {
    logger.warn({ err: error }, "Failed to update conversation memory, keeping existing");
    return serializeMemory({
      ...current,
      messageCount: params.messageCount
    });
  }
}
