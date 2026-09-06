-- Push notifications.
--
-- Three new tables plus two columns. Nothing existing is modified, so
-- this is safe on a live database.

CREATE TYPE "NotificationEvent" AS ENUM (
    'MATCH_REMINDER_30', 'MATCH_REMINDER_15', 'MATCH_TIME_CHANGED', 'NEW_CONTEST',
    'CONTEST_PRIZE', 'ADMIN_BONUS', 'ADMIN_FINE', 'REFERRAL_BONUS', 'REFERRAL_REWARD',
    'COIN_REQUEST_APPROVED', 'COIN_REQUEST_DECLINED',
    'GIFT_APPROVED', 'GIFT_CANCELLED', 'GIFT_EXPIRED',
    'ACCOUNT_VERIFIED', 'VERIFICATION_REMOVED', 'PASSWORD_RESET', 'ACCOUNT_BANNED',
    'CUSTOM'
);

CREATE TYPE "PushStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED');

-- ---------- Devices ----------
CREATE TABLE "push_tokens" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'android',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "push_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "push_tokens_token_key" ON "push_tokens"("token");
CREATE INDEX "push_tokens_userId_isActive_idx" ON "push_tokens"("userId", "isActive");

ALTER TABLE "push_tokens"
    ADD CONSTRAINT "push_tokens_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------- Per-event switches ----------
CREATE TABLE "notification_settings" (
    "event" "NotificationEvent" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "notification_settings_pkey" PRIMARY KEY ("event")
);

-- ---------- Delivery log ----------
CREATE TABLE "push_logs" (
    "id" TEXT NOT NULL,
    "event" "NotificationEvent" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "url" TEXT NOT NULL DEFAULT '',
    "imageUrl" TEXT NOT NULL DEFAULT '',
    "targetUserId" TEXT,
    "recipients" INTEGER NOT NULL DEFAULT 0,
    "delivered" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "status" "PushStatus" NOT NULL DEFAULT 'QUEUED',
    "error" TEXT NOT NULL DEFAULT '',
    "isTest" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "push_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "push_logs_createdAt_idx" ON "push_logs"("createdAt");

-- ---------- Columns ----------
-- Users start opted in; the app offers a switch to turn it off.
ALTER TABLE "users" ADD COLUMN "pushEnabled" BOOLEAN NOT NULL DEFAULT true;

-- Large icon shown inside a notification. The small status-bar icon is a
-- monochrome silhouette bundled with the app — Android strips colour from
-- it, so it can't be set from the admin panel.
ALTER TABLE "app_settings" ADD COLUMN "notificationLogoUrl" TEXT NOT NULL DEFAULT '';
