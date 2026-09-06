-- Run AFTER the migration. The three tables should exist and be empty,
-- and every existing user should be opted in.
SELECT
  (SELECT COUNT(*) FROM "push_tokens")           AS tokens,
  (SELECT COUNT(*) FROM "notification_settings") AS settings,
  (SELECT COUNT(*) FROM "push_logs")             AS logs,
  (SELECT COUNT(*) FROM "users")                 AS users_unchanged,
  (SELECT COUNT(*) FROM "users" WHERE "pushEnabled") AS users_opted_in;
