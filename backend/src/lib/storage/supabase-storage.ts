import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "../env";
import { logger } from "../logger";

let client: SupabaseClient | null = null;

function getStorageClient(): SupabaseClient {
  if (!env.SUPABASE_SECRET_KEY) {
    throw new Error("SUPABASE_SECRET_KEY is not configured; storage operations are unavailable");
  }

  if (!client) {
    client = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  return client;
}

export function referenceStoragePath(characterId: string, fileName: string): string {
  return `characters/${characterId}/references/${fileName}`;
}

export function generatedStoragePath(characterId: string, assetId: string): string {
  return `characters/${characterId}/generated/${assetId}.webp`;
}

export async function uploadImage(params: {
  path: string;
  buffer: Buffer;
  mimeType: string;
}): Promise<{ storagePath: string }> {
  const storage = getStorageClient().storage.from(env.SUPABASE_MEDIA_BUCKET);
  const { error } = await storage.upload(params.path, params.buffer, {
    contentType: params.mimeType,
    upsert: false,
  });

  if (error) {
    throw new Error(`Supabase Storage upload failed for ${params.path}: ${error.message}`);
  }

  return { storagePath: params.path };
}

export async function downloadImage(storagePath: string): Promise<Buffer> {
  const storage = getStorageClient().storage.from(env.SUPABASE_MEDIA_BUCKET);
  const { data, error } = await storage.download(storagePath);

  if (error || !data) {
    throw new Error(`Supabase Storage download failed for ${storagePath}: ${error?.message ?? "empty body"}`);
  }

  return Buffer.from(await data.arrayBuffer());
}

export async function createSignedUrl(storagePath: string, expiresInSeconds?: number): Promise<string | null> {
  const ttl = expiresInSeconds ?? env.SIGNED_URL_TTL_SECONDS;
  const storage = getStorageClient().storage.from(env.SUPABASE_MEDIA_BUCKET);
  const { data, error } = await storage.createSignedUrl(storagePath, ttl);

  if (error || !data?.signedUrl) {
    logger.warn({ storagePath, error: error?.message }, "Failed to create signed URL");
    return null;
  }

  return data.signedUrl;
}

export async function createSignedUrls(
  storagePaths: string[],
  expiresInSeconds?: number
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (storagePaths.length === 0) {
    return result;
  }

  const ttl = expiresInSeconds ?? env.SIGNED_URL_TTL_SECONDS;
  const storage = getStorageClient().storage.from(env.SUPABASE_MEDIA_BUCKET);
  const uniquePaths = [...new Set(storagePaths)];
  const { data, error } = await storage.createSignedUrls(uniquePaths, ttl);

  if (error || !data) {
    logger.warn({ count: uniquePaths.length, error: error?.message }, "Failed to create signed URLs batch");
    return result;
  }

  for (const entry of data) {
    if (entry.path && entry.signedUrl && !entry.error) {
      result.set(entry.path, entry.signedUrl);
    }
  }

  return result;
}

/**
 * Idempotently creates the private media bucket. Intended for the admin setup
 * step; server-side service operations bypass Storage RLS.
 */
export async function ensureMediaBucket(): Promise<{ created: boolean }> {
  const storage = getStorageClient().storage;
  const { data: buckets, error: listError } = await storage.listBuckets();
  if (listError) {
    throw new Error(`Failed to list storage buckets: ${listError.message}`);
  }

  if (buckets?.some((bucket) => bucket.name === env.SUPABASE_MEDIA_BUCKET)) {
    return { created: false };
  }

  const { error } = await storage.createBucket(env.SUPABASE_MEDIA_BUCKET, {
    public: false,
    allowedMimeTypes: ["image/webp", "image/png", "image/jpeg"],
    fileSizeLimit: 10 * 1024 * 1024,
  });

  if (error) {
    throw new Error(`Failed to create media bucket: ${error.message}`);
  }

  return { created: true };
}
