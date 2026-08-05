-- CreateTable
CREATE TABLE "Voice" (
    "id" TEXT NOT NULL,
    "characterId" TEXT NOT NULL,
    "fishVoiceId" TEXT NOT NULL,
    "referenceAudioPath" TEXT,
    "sourceKey" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Voice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Voice_characterId_isActive_idx" ON "Voice"("characterId", "isActive");

-- AddForeignKey
ALTER TABLE "Voice" ADD CONSTRAINT "Voice_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character"("id") ON DELETE CASCADE ON UPDATE CASCADE;