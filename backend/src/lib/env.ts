import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  SUPABASE_URL: z.string().url(),
  PORT: z.coerce.number().default(3001),
  HOST: z.string().default("0.0.0.0"),
  CORS_ORIGIN: z.string().default("*"),
  ADMIN_API_KEY: z.string().min(1),
  OLLAMA_BASE_URL: z.string().url(),
  OLLAMA_MODEL: z.string().min(1),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(40000),
  MAX_INPUT_CHARS: z.coerce.number().int().positive().default(2000),
  MAX_CONTEXT_MESSAGES: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_READ_MAX: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_CHAT_MAX: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_WINDOW: z.string().default("1 minute"),
  EXPO_ACCESS_TOKEN: z.string().optional(),
  PROACTIVE_TICK_MS: z.coerce.number().int().positive().default(600_000),
  PROACTIVE_MATCH_DELAY_MS: z.coerce.number().int().positive().default(1_800_000),
  PROACTIVE_IDLE_MS: z.coerce.number().int().positive().default(14_400_000),
  PROACTIVE_DAILY_CAP: z.coerce.number().int().positive().default(2),
  PROACTIVE_BACKOFF_MS: z.coerce.number().int().positive().default(86_400_000),
  PROACTIVE_MAX_PER_TICK: z.coerce.number().int().positive().default(10),
  IMAGE_REPLIES_ENABLED: z
    .string()
    .default("false")
    .transform((value) => value === "true"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_IMAGE_MODEL: z.string().default("gpt-image-2-2026-04-21"),
  OPENAI_IMAGE_QUALITY: z.enum(["low", "medium", "high"]).default("medium"),
  OPENAI_IMAGE_SIZE: z.string().default("1024x1536"),
  OPENAI_IMAGE_MODERATION: z.enum(["auto", "low"]).default("low"),
  OPENAI_IMAGE_TIMEOUT_MS: z.coerce.number().int().positive().default(180_000),
  SUPABASE_SECRET_KEY: z.string().optional(),
  SUPABASE_MEDIA_BUCKET: z.string().default("character-chat-media"),
  SIGNED_URL_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  IMAGE_DAILY_GENERATION_LIMIT: z.coerce.number().int().positive().default(5),
  IMAGE_CACHE_LIMIT_PER_CHARACTER: z.coerce.number().int().positive().default(20),
  IMAGE_WORKER_POLL_MS: z.coerce.number().int().positive().default(5_000),
  IMAGE_WORKER_LEASE_MS: z.coerce.number().int().positive().default(300_000),
  IMAGE_WORKER_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3)
});

export const env = envSchema.parse(process.env);
