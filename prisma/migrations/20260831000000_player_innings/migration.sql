-- Per-innings player stats.
--
-- match_players keeps the match totals (the sum of these rows), so every
-- existing read and every user_team_players reference is untouched.

CREATE TABLE "match_player_innings" (
    "id" TEXT NOT NULL,
    "matchPlayerId" TEXT NOT NULL,
    "inningsNumber" INTEGER NOT NULL,
    "points" DOUBLE PRECISION NOT NULL DEFAULT 0,

    "runs" INTEGER NOT NULL DEFAULT 0,
    "ballsFaced" INTEGER NOT NULL DEFAULT 0,
    "fours" INTEGER NOT NULL DEFAULT 0,
    "sixes" INTEGER NOT NULL DEFAULT 0,
    "isOut" BOOLEAN NOT NULL DEFAULT false,

    "ballsBowled" INTEGER NOT NULL DEFAULT 0,
    "dotBalls" INTEGER NOT NULL DEFAULT 0,
    "maidens" INTEGER NOT NULL DEFAULT 0,
    "runsConceded" INTEGER NOT NULL DEFAULT 0,
    "wickets" INTEGER NOT NULL DEFAULT 0,
    "wicketsBowledOrLBW" INTEGER NOT NULL DEFAULT 0,

    "catches" INTEGER NOT NULL DEFAULT 0,
    "runOutsDirect" INTEGER NOT NULL DEFAULT 0,
    "runOutsIndirect" INTEGER NOT NULL DEFAULT 0,
    "stumpings" INTEGER NOT NULL DEFAULT 0,

    "minutesPlayed" INTEGER NOT NULL DEFAULT 0,
    "goals" INTEGER NOT NULL DEFAULT 0,
    "assists" INTEGER NOT NULL DEFAULT 0,
    "cleanSheet" BOOLEAN NOT NULL DEFAULT false,
    "yellowCards" INTEGER NOT NULL DEFAULT 0,
    "redCards" INTEGER NOT NULL DEFAULT 0,
    "ownGoals" INTEGER NOT NULL DEFAULT 0,
    "penaltiesSaved" INTEGER NOT NULL DEFAULT 0,
    "penaltiesMissed" INTEGER NOT NULL DEFAULT 0,
    "saves" INTEGER NOT NULL DEFAULT 0,

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "match_player_innings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "match_player_innings_matchPlayerId_inningsNumber_key"
    ON "match_player_innings"("matchPlayerId", "inningsNumber");

CREATE INDEX "match_player_innings_matchPlayerId_idx"
    ON "match_player_innings"("matchPlayerId");

ALTER TABLE "match_player_innings"
    ADD CONSTRAINT "match_player_innings_matchPlayerId_fkey"
    FOREIGN KEY ("matchPlayerId") REFERENCES "match_players"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: everything recorded so far becomes innings 1.
--
-- Every existing match is a single-innings-per-side format, so this is
-- exact — no points change, and re-running the scoring produces the
-- same numbers it did before.
INSERT INTO "match_player_innings" (
    "id", "matchPlayerId", "inningsNumber", "points",
    "runs", "ballsFaced", "fours", "sixes", "isOut",
    "ballsBowled", "dotBalls", "maidens", "runsConceded", "wickets", "wicketsBowledOrLBW",
    "catches", "runOutsDirect", "runOutsIndirect", "stumpings",
    "minutesPlayed", "goals", "assists", "cleanSheet",
    "yellowCards", "redCards", "ownGoals", "penaltiesSaved", "penaltiesMissed", "saves",
    "createdAt", "updatedAt"
)
SELECT
    gen_random_uuid()::text, "id", 1, "points",
    "runs", "ballsFaced", "fours", "sixes", "isOut",
    "ballsBowled", "dotBalls", "maidens", "runsConceded", "wickets", "wicketsBowledOrLBW",
    "catches", "runOutsDirect", "runOutsIndirect", "stumpings",
    "minutesPlayed", "goals", "assists", "cleanSheet",
    "yellowCards", "redCards", "ownGoals", "penaltiesSaved", "penaltiesMissed", "saves",
    "createdAt", CURRENT_TIMESTAMP
FROM "match_players";
