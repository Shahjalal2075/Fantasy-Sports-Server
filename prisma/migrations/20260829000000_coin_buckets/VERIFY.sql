-- Run this AFTER the migration. Every row should report OK.
SELECT
  COUNT(*) FILTER (WHERE "coins" <> "depositCoins" + "withdrawableCoins") AS mismatched_totals,
  COUNT(*) FILTER (WHERE "depositCoins" < 0 OR "withdrawableCoins" < 0)   AS negative_buckets,
  COUNT(*)                                                                AS total_users,
  SUM("coins")                                                            AS total_coins
FROM "users";
