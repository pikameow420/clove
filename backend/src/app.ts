import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import rateLimit from "@fastify/rate-limit";
import { logger } from "./lib/logger";
import { env } from "./lib/env";
import { authPlugin } from "./modules/auth/auth";
import { characterRoutes } from "./modules/characters/routes";
import { swipeRoutes } from "./modules/swipes/routes";
import { conversationRoutes } from "./modules/conversations/routes";
import { userRoutes } from "./modules/users/routes";

export function buildApp() {
  const app = Fastify({
    loggerInstance: logger,
  });

  app.register(cors, {
    origin: env.CORS_ORIGIN === "*" ? true : env.CORS_ORIGIN
  });
  app.register(sensible);
  app.register(rateLimit, {
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW,
    keyGenerator: (request) => {
      const auth = request.headers.authorization;
      if (auth?.startsWith("Bearer ")) {
        return auth.slice("Bearer ".length, "Bearer ".length + 32);
      }
      return request.ip;
    },
  });

  app.get("/health", async () => ({ ok: true }));

  app.register(authPlugin);
  app.register(characterRoutes);
  app.register(swipeRoutes);
  app.register(conversationRoutes);
  app.register(userRoutes);

  return app;
}
