import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { Message, MessageRole } from "../generated/prisma/client";
import { prisma, connectDb, disconnectDb } from "../lib/db/prisma";
import { generateCharacterReply, type CharacterReply } from "../modules/llm/chat-service";

function toMessage(role: MessageRole, content: string): Message {
  return {
    id: `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    conversationId: "cli-session",
    role,
    content,
    segments: null,
    tokenCount: null,
    source: null,
    proactiveTrigger: null,
    mediaStatus: "none",
    createdAt: new Date()
  };
}

const DIM_ITALIC = "\x1b[2;3m";
const RESET = "\x1b[0m";

/** Mirrors the app, where narration renders as an italic block rather than a bubble. */
function renderReply(reply: CharacterReply): string {
  if (!reply.segments) {
    return reply.content;
  }
  return reply.segments
    .map((segment) => (segment.type === "narration" ? `${DIM_ITALIC}${segment.text}${RESET}` : segment.text))
    .join("\n");
}

async function main(): Promise<void> {
  await connectDb();

  const rl = createInterface({ input, output });
  console.log("\nCharacter Chat CLI");
  console.log("Type /exit to quit, /reset to clear history.\n");

  const characters = await prisma.character.findMany({
    where: { isActive: true },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      about: true,
      gender: true,
      interests: true,
      personaSystemPrompt: true,
      personaFacts: true,
      openingMessages: true,
      profile: true,
      ttsVoiceKey: true,
      isActive: true,
      createdAt: true,
      updatedAt: true,
      imageUrl: true
    }
  });

  if (!characters.length) {
    console.log("No active characters found. Import one first using /characters/admin/import.");
    rl.close();
    await disconnectDb();
    return;
  }

  console.log("Available characters:");
  characters.forEach((character, index) => {
    console.log(`${index + 1}. ${character.name} - ${character.about}`);
  });

  const selectedRaw = await rl.question("\nSelect character number: ");
  const selectedIndex = Number(selectedRaw) - 1;
  const selected = characters[selectedIndex];

  if (!selected) {
    console.log("Invalid selection.");
    rl.close();
    await disconnectDb();
    return;
  }

  console.log(`\nChatting with ${selected.name}.`);
  let history: Message[] = [];

  while (true) {
    const userInput = (await rl.question("\nYou: ")).trim();

    if (!userInput) {
      continue;
    }
    if (userInput === "/exit") {
      break;
    }
    if (userInput === "/reset") {
      history = [];
      console.log("Conversation history cleared.");
      continue;
    }

    const reply = await generateCharacterReply({
      character: selected,
      summary: null,
      recentMessages: history,
      userInput
    });

    history.push(toMessage("user", userInput));
    history.push(toMessage("assistant", reply.content));
    console.log(`\n${selected.name}: ${renderReply(reply)}`);
  }

  rl.close();
  await disconnectDb();
}

main().catch(async (error) => {
  console.error("CLI failed:", error);
  await disconnectDb();
  process.exit(1);
});
