-- Coin requests: a user asks an agent for coins, the agent decides.
--
-- Three new tables and a handful of settings columns. No existing table,
-- column or row is modified, so this is safe on a live database.

CREATE TYPE "CoinRequestStatus" AS ENUM ('PENDING', 'HELD', 'APPROVED', 'REJECTED');
CREATE TYPE "CouponBonusType" AS ENUM ('FIXED', 'PERCENTAGE');

ALTER TYPE "CoinTransactionType" ADD VALUE 'COIN_REQUEST';

-- ---------- Agents ----------
CREATE TABLE "request_agents" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "logoUrl" TEXT NOT NULL DEFAULT '',
    "method" TEXT NOT NULL DEFAULT '',
    "number" TEXT NOT NULL DEFAULT '',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "request_agents_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "request_agents_isActive_sortOrder_idx" ON "request_agents"("isActive", "sortOrder");

-- ---------- Coupons ----------
CREATE TABLE "coin_coupons" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "bonusType" "CouponBonusType" NOT NULL DEFAULT 'PERCENTAGE',
    "bonusValue" INTEGER NOT NULL DEFAULT 0,
    "minCoins" INTEGER NOT NULL DEFAULT 0,
    "maxCoins" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "coin_coupons_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "coin_coupons_code_key" ON "coin_coupons"("code");
CREATE INDEX "coin_coupons_isActive_idx" ON "coin_coupons"("isActive");

-- ---------- Requests ----------
CREATE TABLE "coin_requests" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "CoinRequestStatus" NOT NULL DEFAULT 'PENDING',
    "coinAmount" INTEGER NOT NULL,
    "bonusAmount" INTEGER NOT NULL DEFAULT 0,
    "totalAmount" INTEGER NOT NULL,
    "reason" TEXT NOT NULL DEFAULT '',
    "agentId" TEXT,
    "agentName" TEXT NOT NULL DEFAULT '',
    "agentLogo" TEXT NOT NULL DEFAULT '',
    "agentMethod" TEXT NOT NULL DEFAULT '',
    "agentNumber" TEXT NOT NULL DEFAULT '',
    "couponId" TEXT,
    "couponCode" TEXT NOT NULL DEFAULT '',
    "adminNote" TEXT NOT NULL DEFAULT '',
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "coin_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "coin_requests_status_createdAt_idx" ON "coin_requests"("status", "createdAt");
CREATE INDEX "coin_requests_userId_createdAt_idx" ON "coin_requests"("userId", "createdAt");

ALTER TABLE "coin_requests"
    ADD CONSTRAINT "coin_requests_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Agents and coupons are switched off rather than deleted, but SET NULL
-- keeps a request readable even if one is removed directly.
ALTER TABLE "coin_requests"
    ADD CONSTRAINT "coin_requests_agentId_fkey"
    FOREIGN KEY ("agentId") REFERENCES "request_agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "coin_requests"
    ADD CONSTRAINT "coin_requests_couponId_fkey"
    FOREIGN KEY ("couponId") REFERENCES "coin_coupons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------- Settings ----------
ALTER TABLE "app_settings" ADD COLUMN "coinRequestEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "app_settings" ADD COLUMN "coinRequestMessenger" TEXT NOT NULL DEFAULT '';
ALTER TABLE "app_settings" ADD COLUMN "coinRequestTelegram" TEXT NOT NULL DEFAULT '';
ALTER TABLE "app_settings" ADD COLUMN "coinRequestMinCoins" INTEGER NOT NULL DEFAULT 10;
ALTER TABLE "app_settings" ADD COLUMN "coinRequestMaxPending" INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "app_settings" ADD COLUMN "coinRequestNote" TEXT NOT NULL DEFAULT '';
