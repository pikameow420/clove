import type { Character, Message } from "../../generated/prisma/client";
import type { ProactiveTrigger } from "../../generated/prisma/client";
import { env } from "../../lib/env";
import { buildLlmMessages, type LlmChatMessage } from "../llm/prompt-builder";

function buildProactiveInstruction(trigger: ProactiveTrigger, idleHours?: number): string {
  switch (trigger) {
    case "post_match":
      return [
        "[System event: you matched with this person but they have not texted yet.]",
        "Send a natural first message as yourself, 1-2 short lines, in character.",
        "Do not mention matching or the app explicitly.",
        "Keep it light and inviting, not needy."
      ].join(" ");
    case "idle": {
      const hours = idleHours ?? Math.round(env.PROACTIVE_IDLE_MS / 3_600_000);
      return [
        `[System event: they have not replied in about ${hours} hours.]`,
        "Send a light check-in, 1-2 short lines, in character.",
        "No guilt-tripping. Reference something from the chat only if it fits naturally."
      ].join(" ");
    }
    default: {
      const _exhaustive: never = trigger;
      return _exhaustive;
    }
  }
}

export function buildProactiveLlmMessages(params: {
  character: Character;
  recentMessages: Message[];
  summary: string | null;
  trigger: ProactiveTrigger;
  idleHours?: number;
  intimacyLevel?: number;
}): LlmChatMessage[] {
  const syntheticInput = buildProactiveInstruction(params.trigger, params.idleHours);
  const messages = buildLlmMessages({
    character: params.character,
    recentMessages: params.recentMessages,
    summary: params.summary,
    userInput: syntheticInput,
    intimacyLevel: params.intimacyLevel
  });

  return messages.map((message) => {
    if (message.role === "user" && message.content === syntheticInput) {
      return {
        role: "system" as const,
        content: `Proactive outreach instruction:\n${syntheticInput}`
      };
    }
    return message;
  });
}
