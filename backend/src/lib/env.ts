import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  SUPABASE_URL: z.string().url(),
  PORT: z.coerce.number().default(3001),
  HOST: z.string().default("0.0.0.0"),
  CORS_ORIGIN: z.string().default("*"),
  ADMIN_API_KEY: z.string().min(1),
  LLM_PROVIDER: z.enum(["ollama", "gemini"]).default("ollama"),
  OLLAMA_BASE_URL: z.string().url().optional(),
  OLLAMA_MODEL: z.string().min(1).optional(),
  GEMINI_API_KEY: z.string().min(1).optional(),
  GEMINI_BASE_URL: z.string().url().default("https://generativelanguage.googleapis.com/v1beta"),
  GEMINI_MODEL: z.string().min(1).default("gemini-flash-lite-latest"),
  // Flash-Lite reasons before answering by default, which costs seconds of
  // latency we do not want in a chat. Set to "off" for models that reject it.
  GEMINI_THINKING_LEVEL: z.enum(["off", "minimal", "low", "medium", "high"]).default("minimal"),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(40000),
  ROLEPLAY_ENABLED: z
    .string()
    .default("true")
    .transform((value) => value !== "false"),
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

/**
 * Only the credentials for the selected provider are required, so switching to
 * Gemini needs nothing but GEMINI_API_KEY and does not force an Ollama host to
 * stay configured.
 */
function assertProviderCredentials(value: z.infer<typeof envSchema>, ctx: z.RefinementCtx): void {
  switch (value.LLM_PROVIDER) {
    case "ollama": {
      if (!value.OLLAMA_BASE_URL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["OLLAMA_BASE_URL"],
          message: "OLLAMA_BASE_URL is required when LLM_PROVIDER is \"ollama\""
        });
      }
      if (!value.OLLAMA_MODEL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["OLLAMA_MODEL"],
          message: "OLLAMA_MODEL is required when LLM_PROVIDER is \"ollama\""
        });
      }
      return;
    }
    case "gemini": {
      if (!value.GEMINI_API_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["GEMINI_API_KEY"],
          message: "GEMINI_API_KEY is required when LLM_PROVIDER is \"gemini\""
        });
      }
      return;
    }
    default: {
      const exhaustive: never = value.LLM_PROVIDER;
      throw new Error(`Unhandled LLM provider: ${exhaustive}`);
    }
  }
}

export const env = envSchema.superRefine(assertProviderCredentials).parse(process.env);
