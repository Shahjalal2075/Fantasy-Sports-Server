-- Editable wording for each automatic notification.
--
-- Blank means the built-in text is used. Placeholders such as {fixture}
-- or {coins} are filled at send time.
--
-- IF NOT EXISTS because this arrived as a correction: the columns were
-- briefly part of the previous migration, so a database that ran that
-- version already has them.
ALTER TABLE "notification_settings"
  ADD COLUMN IF NOT EXISTS "title" TEXT NOT NULL DEFAULT '';

ALTER TABLE "notification_settings"
  ADD COLUMN IF NOT EXISTS "body" TEXT NOT NULL DEFAULT '';
