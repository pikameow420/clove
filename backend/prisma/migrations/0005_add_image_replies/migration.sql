-- CreateEnum
CREATE TYPE "MediaStatus" AS ENUM ('none', 'pending', 'ready', 'rejected', 'failed');

-- CreateEnum
CREATE TYPE "AttachmentType" AS ENUM ('image');

-- CreateEnum
CREATE TYPE "ImageAssetKind" AS ENUM ('reference', 'generated');

-- CreateEnum
CREATE TYPE "ImageAssetModeration" AS ENUM ('approved', 'blocked');

-- CreateEnum
CREATE TYPE "ImageRequestStatus" AS ENUM ('queued', 'processing', 'ready', 'rejected', 'failed');

-- AlterTable
ALTER TABLE "User" ADD COLUMN "dateOfBirth" TIMESTAMP(3),
ADD COLUMN "adultConfirmedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Message" ADD COLUMN "mediaStatus" "MediaStatus" NOT NULL DEFAULT 'none';

-- CreateTable
CREATE TABLE "MessageAttachment" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "type" "AttachmentType" NOT NULL DEFAULT 'image',
    "storagePath" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "assetId" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CharacterImageAsset" (
    "id" TEXT NOT NULL,
    "characterId" TEXT NOT NULL,
    "kind" "ImageAssetKind" NOT NULL,
    "storagePath" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL DEFAULT 'image/webp',
    "sceneKey" TEXT,
    "tags" JSONB NOT NULL DEFAULT '[]',
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isReusable" BOOLEAN NOT NULL DEFAULT true,
    "moderation" "ImageAssetModeration" NOT NULL DEFAULT 'approved',
    "lastUsedAt" TIMESTAMP(3),
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CharacterImageAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImageGenerationRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "characterId" TEXT NOT NULL,
    "userMessageId" TEXT NOT NULL,
    "assistantMessageId" TEXT,
    "status" "ImageRequestStatus" NOT NULL DEFAULT 'queued',
    "decisionReason" TEXT,
    "brief" JSONB NOT NULL DEFAULT '{}',
    "assetId" TEXT,
    "cacheHit" BOOLEAN NOT NULL DEFAULT false,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "leasedUntil" TIMESTAMP(3),
    "generationReservedAt" TIMESTAMP(3),
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImageGenerationRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MessageAttachment_messageId_idx" ON "MessageAttachment"("messageId");

-- CreateIndex
CREATE INDEX "MessageAttachment_assetId_idx" ON "MessageAttachment"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "CharacterImageAsset_storagePath_key" ON "CharacterImageAsset"("storagePath");

-- CreateIndex
CREATE INDEX "CharacterImageAsset_characterId_kind_isActive_isReusable_idx" ON "CharacterImageAsset"("characterId", "kind", "isActive", "isReusable");

-- CreateIndex
CREATE INDEX "CharacterImageAsset_characterId_sceneKey_idx" ON "CharacterImageAsset"("characterId", "sceneKey");

-- CreateIndex
CREATE UNIQUE INDEX "ImageGenerationRequest_userMessageId_key" ON "ImageGenerationRequest"("userMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "ImageGenerationRequest_assistantMessageId_key" ON "ImageGenerationRequest"("assistantMessageId");

-- CreateIndex
CREATE INDEX "ImageGenerationRequest_status_leasedUntil_idx" ON "ImageGenerationRequest"("status", "leasedUntil");

-- CreateIndex
CREATE INDEX "ImageGenerationRequest_userId_generationReservedAt_idx" ON "ImageGenerationRequest"("userId", "generationReservedAt");

-- CreateIndex
CREATE INDEX "ImageGenerationRequest_conversationId_createdAt_idx" ON "ImageGenerationRequest"("conversationId", "createdAt");

-- AddForeignKey
ALTER TABLE "MessageAttachment" ADD CONSTRAINT "MessageAttachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageAttachment" ADD CONSTRAINT "MessageAttachment_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "CharacterImageAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CharacterImageAsset" ADD CONSTRAINT "CharacterImageAsset_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImageGenerationRequest" ADD CONSTRAINT "ImageGenerationRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImageGenerationRequest" ADD CONSTRAINT "ImageGenerationRequest_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImageGenerationRequest" ADD CONSTRAINT "ImageGenerationRequest_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "CharacterImageAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
