-- Pairing records for the separate live-score service.
--
-- Two new tables only. No existing table, column or row is touched, so
-- this is safe to run against a live database.

CREATE TABLE "match_live_links" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "liveMatchId" TEXT,
    "liveLabel" TEXT NOT NULL DEFAULT '',
    "connectedAt" TIMESTAMP(3),
    "lastScoreAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "match_live_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "match_live_links_matchId_key" ON "match_live_links"("matchId");
CREATE UNIQUE INDEX "match_live_links_code_key" ON "match_live_links"("code");

ALTER TABLE "match_live_links"
    ADD CONSTRAINT "match_live_links_matchId_fkey"
    FOREIGN KEY ("matchId") REFERENCES "matches"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "player_live_links" (
    "id" TEXT NOT NULL,
    "matchPlayerId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "liveName" TEXT NOT NULL DEFAULT '',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "matchedAutomatically" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "player_live_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "player_live_links_matchPlayerId_key" ON "player_live_links"("matchPlayerId");

ALTER TABLE "player_live_links"
    ADD CONSTRAINT "player_live_links_matchPlayerId_fkey"
    FOREIGN KEY ("matchPlayerId") REFERENCES "match_players"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
