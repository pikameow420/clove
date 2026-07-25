import "dotenv/config";
import { createHash } from "node:crypto";
import Fastify, { type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import rateLimit from "@fastify/rate-limit";
import { logger } from "./lib/logger";
import { env } from "./lib/env";
import { authPlugin } from "./modules/auth/auth";
import { characterRoutes } from "./modules/characters/routes";
import { swipeRoutes } from "./modules/swipes/routes";
import { conversationRoutes } from "./modules/conversations/routes";
import { proactiveAdminRoutes } from "./modules/proactive/routes";
import { imageAdminRoutes } from "./modules/images/routes";
import { userRoutes } from "./modules/users/routes";

type RateLimitBucket = "read" | "chat" | "write";

/**
 * Reads `sub` without verifying the signature. The auth plugin still verifies
 * every token, so a forged subject buys its own rate-limit bucket and nothing
 * else. We cannot use `request.user` here because rate limiting runs in
 * `onRequest`, well before authentication resolves the user.
 */
function unverifiedTokenSubject(token: string): string | null {
  const payload = token.split(".")[1];
  if (!payload) {
    return null;
  }
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      sub?: unknown;
    };
    return typeof claims.sub === "string" && claims.sub.length > 0 ? claims.sub : null;
  } catch {
    return null;
  }
}

/**
 * Identifies the caller for rate limiting. This used to slice the first 32
 * characters of the bearer token, which is the base64url JWT header and is
 * byte-identical for every user of the project — so every authenticated user
 * shared a single bucket and the chat limit was a global cap.
 */
function rateLimitIdentity(request: FastifyRequest): string {
  const auth = request.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    return `ip:${request.ip}`;
  }

  const token = auth.slice("Bearer ".length);
  const subject = unverifiedTokenSubject(token);
  if (subject) {
    return `user:${subject}`;
  }

  // Unparseable token: still per-caller, just not stable across a token refresh.
  return `token:${createHash("sha256").update(token).digest("hex")}`;
}

/** Separate counters so reads/writes don't burn the chat message budget. */
function rateLimitBucket(request: FastifyRequest): RateLimitBucket {
  if (request.method === "GET") {
    return "read";
  }
  if (
    request.method === "POST" &&
    /\/conversations\/[^/]+\/messages/.test(request.url)
  ) {
    return "chat";
  }
  return "write";
}

function rateLimitMax(bucket: RateLimitBucket): number {
  switch (bucket) {
    case "read":
      return env.RATE_LIMIT_READ_MAX;
    case "chat":
      return env.RATE_LIMIT_CHAT_MAX;
    case "write":
      return env.RATE_LIMIT_MAX;
    default: {
      const exhaustive: never = bucket;
      throw new Error(`Unhandled rate limit bucket: ${exhaustive}`);
    }
  }
}

export function buildApp() {
  const app = Fastify({
    loggerInstance: logger,
  });

  app.register(cors, {
    origin: env.CORS_ORIGIN === "*" ? true : env.CORS_ORIGIN
  });
  app.register(sensible);
  app.register(rateLimit, {
    max: (request) => rateLimitMax(rateLimitBucket(request)),
    timeWindow: env.RATE_LIMIT_WINDOW,
    keyGenerator: (request) => `${rateLimitIdentity(request)}:${rateLimitBucket(request)}`,
  });

  app.get("/health", async () => ({ ok: true }));

  app.register(authPlugin);
  app.register(characterRoutes);
  app.register(swipeRoutes);
  app.register(conversationRoutes);
  app.register(proactiveAdminRoutes);
  app.register(imageAdminRoutes);
  app.register(userRoutes);

  return app;
}
