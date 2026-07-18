-- CreateEnum
CREATE TYPE "MessageSource" AS ENUM ('assistant_reply', 'assistant_proactive');

-- CreateEnum
CREATE TYPE "ProactiveTrigger" AS ENUM ('post_match', 'idle');

-- AlterTable
ALTER TABLE "User" ADD COLUMN "proactiveEnabled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN "lastUserMessageAt" TIMESTAMP(3),
ADD COLUMN "lastProactiveMessageAt" TIMESTAMP(3),
ADD COLUMN "consecutiveProactiveCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "proactiveBackoffUntil" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Message" ADD COLUMN "source" "MessageSource",
ADD COLUMN "proactiveTrigger" "ProactiveTrigger";

-- Backfill existing assistant messages
UPDATE "Message" SET "source" = 'assistant_reply' WHERE "role" = 'assistant' AND "source" IS NULL;

-- CreateIndex
CREATE INDEX "Conversation_userId_lastUserMessageAt_idx" ON "Conversation"("userId", "lastUserMessageAt");

-- CreateIndex
CREATE INDEX "Message_conversationId_source_createdAt_idx" ON "Message"("conversationId", "source", "createdAt");
