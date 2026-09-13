-- Remembers how the auto-teams tool was set up for a match.
--
-- One new table. Nothing existing is touched.

CREATE TABLE "auto_team_setups" (
    "matchId" TEXT NOT NULL,
    "userIds" JSONB NOT NULL DEFAULT '[]',
    "pool" JSONB NOT NULL DEFAULT '[]',
    "captainIds" JSONB NOT NULL DEFAULT '[]',
    "viceCaptainIds" JSONB NOT NULL DEFAULT '[]',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "auto_team_setups_pkey" PRIMARY KEY ("matchId")
);

ALTER TABLE "auto_team_setups"
    ADD CONSTRAINT "auto_team_setups_matchId_fkey"
    FOREIGN KEY ("matchId") REFERENCES "matches"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
