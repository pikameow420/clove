-- CreateEnum
CREATE TYPE "IntimacyEventType" AS ENUM (
  'user_message',
  'user_message_meaningful',
  'answered_question',
  'shared_day',
  'proactive_sent',
  'proactive_reply',
  'photo_moment_cache',
  'photo_moment_generated',
  'photo_request_accepted',
  'memory_warmth'
);

-- AlterTable
ALTER TABLE "Conversation"
ADD COLUMN "intimacyLevel" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "intimacyScore" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "Conversation"
ADD CONSTRAINT "Conversation_intimacyLevel_check" CHECK ("intimacyLevel" >= 1 AND "intimacyLevel" <= 5);

ALTER TABLE "Conversation"
ADD CONSTRAINT "Conversation_intimacyScore_check" CHECK ("intimacyScore" >= 0 AND "intimacyScore" <= 100);

-- CreateTable
CREATE TABLE "IntimacyEvent" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "eventType" "IntimacyEventType" NOT NULL,
    "sourceId" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntimacyEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "IntimacyEvent_points_check" CHECK ("points" >= 0)
);

-- CreateIndex
CREATE UNIQUE INDEX "IntimacyEvent_conversationId_eventType_sourceId_key" ON "IntimacyEvent"("conversationId", "eventType", "sourceId");

-- CreateIndex
CREATE INDEX "IntimacyEvent_conversationId_createdAt_idx" ON "IntimacyEvent"("conversationId", "createdAt");

-- AddForeignKey
ALTER TABLE "IntimacyEvent" ADD CONSTRAINT "IntimacyEvent_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
