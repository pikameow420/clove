-- Backend-owned tables are accessed only through the Fastify API.
-- No anon/authenticated policies are intentional: Supabase Data API clients
-- must not be able to access these rows. The backend connects as a role with
-- BYPASSRLS, so direct Prisma access remains available.
ALTER TABLE public."_prisma_migrations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."User" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."Character" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."Swipe" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."Conversation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."Message" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."MessageAttachment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."CharacterImageAsset" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ImageGenerationRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."IntimacyEvent" ENABLE ROW LEVEL SECURITY;
