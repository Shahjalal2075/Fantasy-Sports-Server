-- Run AFTER the migration. Both counts must match, and the totals must
-- be identical — the backfill copies, it doesn't recompute.
SELECT
  (SELECT COUNT(*) FROM "match_players")                                AS match_players,
  (SELECT COUNT(*) FROM "match_player_innings")                         AS innings_rows,
  (SELECT COALESCE(SUM("runs"), 0) FROM "match_players")                AS runs_before,
  (SELECT COALESCE(SUM("runs"), 0) FROM "match_player_innings")         AS runs_after,
  (SELECT COALESCE(SUM("points"), 0) FROM "match_players")              AS points_before,
  (SELECT COALESCE(SUM("points"), 0) FROM "match_player_innings")       AS points_after;
