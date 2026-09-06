-- Per-event notification settings.
--
--   saveInApp — whether it's also kept in the app's notification list,
--               separate from whether a push is sent at all
--   title/body — the admin's own wording; blank means the built-in text
ALTER TABLE "notification_settings"
  ADD COLUMN "saveInApp" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "notification_settings"
  ADD COLUMN "title" TEXT NOT NULL DEFAULT '';

ALTER TABLE "notification_settings"
  ADD COLUMN "body" TEXT NOT NULL DEFAULT '';
