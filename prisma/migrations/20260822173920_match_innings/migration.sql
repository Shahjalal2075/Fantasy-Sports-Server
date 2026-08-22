-- CreateTable
CREATE TABLE "match_innings" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "inningsNumber" INTEGER NOT NULL,
    "runs" INTEGER NOT NULL DEFAULT 0,
    "wickets" INTEGER NOT NULL DEFAULT 0,
    "balls" INTEGER NOT NULL DEFAULT 0,
    "isDeclared" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "match_innings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "match_innings_matchId_idx" ON "match_innings"("matchId");

-- CreateIndex
CREATE UNIQUE INDEX "match_innings_matchId_inningsNumber_key" ON "match_innings"("matchId", "inningsNumber");

-- AddForeignKey
ALTER TABLE "match_innings" ADD CONSTRAINT "match_innings_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_innings" ADD CONSTRAINT "match_innings_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
