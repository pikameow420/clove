import { prisma } from "../../lib/db/prisma";
import { env } from "../env";
import { logger } from "../logger";

type PushPayload = {
  token: string;
  title: string;
  body: string;
  data: Record<string, string>;
};

function truncatePreview(text: string, maxLength = 120): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength - 1)}…`;
}

export async function sendExpoPushNotification(payload: PushPayload): Promise<void> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  if (env.EXPO_ACCESS_TOKEN) {
    headers.Authorization = `Bearer ${env.EXPO_ACCESS_TOKEN}`;
  }

  try {
    const response = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers,
      body: JSON.stringify([
        {
          to: payload.token,
          sound: "default",
          title: payload.title,
          body: payload.body,
          data: payload.data,
        },
      ]),
    });

    if (!response.ok) {
      const text = await response.text();
      logger.warn({ status: response.status, text }, "Expo push request failed");
    }
  } catch (error) {
    logger.warn({ err: error }, "Failed to send Expo push notification");
  }
}

export async function notifyAssistantReply(params: {
  userId: string;
  characterId: string;
  characterName: string;
  conversationId: string;
  replyContent: string;
}): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: params.userId },
    select: { expoPushToken: true },
  });

  if (!user?.expoPushToken) return;

  await sendExpoPushNotification({
    token: user.expoPushToken,
    title: params.characterName,
    body: truncatePreview(params.replyContent),
    data: {
      conversationId: params.conversationId,
      characterId: params.characterId,
      characterName: params.characterName,
    },
  });
}
