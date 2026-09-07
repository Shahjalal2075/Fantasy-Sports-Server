-- Reusable contest shapes, applied when creating a contest on a match.
--
-- One new table. Nothing existing is touched.

CREATE TABLE "contest_presets" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "maxEntries" INTEGER NOT NULL DEFAULT 10000,
    "entryCost" INTEGER NOT NULL DEFAULT 0,
    "prizeDistribution" JSONB NOT NULL DEFAULT '[]',
    "description" TEXT NOT NULL DEFAULT '',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "contest_presets_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "contest_presets_isActive_sortOrder_idx"
    ON "contest_presets"("isActive", "sortOrder");
