-- AlterTable
-- Parsed roleplay segments for assistant replies: [{"type":"narration"|"dialogue","text":"..."}]
-- Nullable so existing rows and plain dialogue turns keep using "content" directly.
ALTER TABLE "Message" ADD COLUMN "segments" JSONB;
