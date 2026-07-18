import type { Message, MessageAttachment } from "../../generated/prisma/client";
import { env } from "../../lib/env";
import { createSignedUrls } from "../../lib/storage/supabase-storage";

export type MessageWithAttachments = Message & { attachments: MessageAttachment[] };

export type SerializedAttachment = {
  id: string;
  type: string;
  mimeType: string;
  width: number | null;
  height: number | null;
  url: string | null;
  urlExpiresInSeconds: number;
};

export type SerializedMessage = Omit<MessageWithAttachments, "attachments"> & {
  attachments: SerializedAttachment[];
};

/**
 * Serializes messages with short-lived signed URLs for their attachments.
 * Signed URLs are generated in one batch and never persisted.
 */
export async function serializeMessagesWithAttachments(
  messages: MessageWithAttachments[]
): Promise<SerializedMessage[]> {
  const storagePaths = messages.flatMap((message) =>
    message.attachments.map((attachment) => attachment.storagePath)
  );

  const signedUrls = storagePaths.length > 0 ? await createSignedUrls(storagePaths) : new Map<string, string>();

  return messages.map((message) => ({
    ...message,
    attachments: message.attachments.map((attachment) => ({
      id: attachment.id,
      type: attachment.type,
      mimeType: attachment.mimeType,
      width: attachment.width,
      height: attachment.height,
      url: signedUrls.get(attachment.storagePath) ?? null,
      urlExpiresInSeconds: env.SIGNED_URL_TTL_SECONDS,
    })),
  }));
}

export async function serializeMessageWithAttachments(
  message: MessageWithAttachments
): Promise<SerializedMessage> {
  const [serialized] = await serializeMessagesWithAttachments([message]);
  return serialized!;
}
