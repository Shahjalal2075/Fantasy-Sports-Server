-- Run AFTER the migration. Both tables should exist and be empty; the
-- existing tables must be untouched.
SELECT
  (SELECT COUNT(*) FROM "match_live_links")  AS match_links,
  (SELECT COUNT(*) FROM "player_live_links") AS player_links,
  (SELECT COUNT(*) FROM "matches")           AS matches_unchanged,
  (SELECT COUNT(*) FROM "match_players")     AS match_players_unchanged;
