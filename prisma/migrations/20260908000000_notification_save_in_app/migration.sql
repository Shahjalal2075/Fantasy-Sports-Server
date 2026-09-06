-- Whether an event's notification is also kept in the app's list.
--
-- Separate from "enabled", which only decides whether a push is sent.
-- Existing rows default to true, matching how it behaved before.
ALTER TABLE "notification_settings"
  ADD COLUMN "saveInApp" BOOLEAN NOT NULL DEFAULT true;
