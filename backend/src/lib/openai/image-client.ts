import OpenAI, { toFile } from "openai";
import { env } from "../env";

export class ImageModerationBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageModerationBlockedError";
  }
}

export class ImageGenerationRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageGenerationRetryableError";
  }
}

let client: OpenAI | null = null;

function getOpenAiClient(): OpenAI {
  if (!env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured; image generation is unavailable");
  }

  if (!client) {
    client = new OpenAI({
      apiKey: env.OPENAI_API_KEY,
      timeout: env.OPENAI_IMAGE_TIMEOUT_MS,
      maxRetries: 0,
    });
  }

  return client;
}

export type ReferenceInput = {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
};

export type GeneratedImage = {
  buffer: Buffer;
  mimeType: string;
};

function isModerationBlocked(error: unknown): boolean {
  if (!(error instanceof OpenAI.APIError)) {
    return false;
  }
  const code = typeof error.code === "string" ? error.code : "";
  return code === "moderation_blocked" || code === "content_policy_violation";
}

function isRetryable(error: unknown): boolean {
  if (error instanceof OpenAI.APIConnectionError || error instanceof OpenAI.APIConnectionTimeoutError) {
    return true;
  }
  if (error instanceof OpenAI.APIError) {
    return error.status === 429 || (typeof error.status === "number" && error.status >= 500);
  }
  return false;
}

/**
 * Generates one character image from up to five reference images plus a
 * validated prompt using the pinned GPT Image 2 snapshot. Callers must never
 * pass raw user text as the prompt.
 */
export async function generateCharacterImage(params: {
  references: ReferenceInput[];
  prompt: string;
}): Promise<GeneratedImage> {
  if (params.references.length < 1) {
    throw new Error("At least one reference image is required");
  }

  const openai = getOpenAiClient();
  const images = await Promise.all(
    params.references
      .slice(0, 5)
      .map((reference) => toFile(reference.buffer, reference.fileName, { type: reference.mimeType }))
  );

  // `moderation` is accepted by the GPT Image 2 endpoint but the installed SDK
  // types do not include it on images.edit yet, hence the cast.
  const body = {
    model: env.OPENAI_IMAGE_MODEL,
    image: images,
    prompt: params.prompt,
    size: env.OPENAI_IMAGE_SIZE as "1024x1536",
    quality: env.OPENAI_IMAGE_QUALITY,
    output_format: "webp",
    moderation: env.OPENAI_IMAGE_MODERATION,
    n: 1,
  } as unknown as OpenAI.Images.ImageEditParamsNonStreaming;

  let response;
  try {
    response = await openai.images.edit(body);
  } catch (error) {
    if (isModerationBlocked(error)) {
      throw new ImageModerationBlockedError("OpenAI blocked the image generation request");
    }
    if (isRetryable(error)) {
      throw new ImageGenerationRetryableError(
        error instanceof Error ? error.message : "Transient OpenAI failure"
      );
    }
    throw error;
  }

  const b64 = response.data?.[0]?.b64_json;
  if (!b64) {
    throw new Error("OpenAI returned no image data");
  }

  return { buffer: Buffer.from(b64, "base64"), mimeType: "image/webp" };
}
