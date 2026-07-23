import "dotenv/config";
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
    keyGenerator: (request) => {
      const auth = request.headers.authorization;
      const identity = auth?.startsWith("Bearer ")
        ? auth.slice("Bearer ".length, "Bearer ".length + 32)
        : request.ip;
      return `${identity}:${rateLimitBucket(request)}`;
    },
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
