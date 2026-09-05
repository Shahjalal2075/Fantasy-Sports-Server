-- Run AFTER the migration. The three new tables should exist and be
-- empty; existing tables must be untouched.
SELECT
  (SELECT COUNT(*) FROM "request_agents")  AS agents,
  (SELECT COUNT(*) FROM "coin_coupons")    AS coupons,
  (SELECT COUNT(*) FROM "coin_requests")   AS requests,
  (SELECT COUNT(*) FROM "users")           AS users_unchanged,
  (SELECT COALESCE(SUM("coins"), 0) FROM "users") AS coins_unchanged;
