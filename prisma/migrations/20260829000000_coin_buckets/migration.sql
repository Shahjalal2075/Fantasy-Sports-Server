-- Split the coin balance into two buckets.
--
--   depositCoins      — bonuses, promo codes, referrals, admin grants
--   withdrawableCoins — winnings from contests
--
-- "coins" stays as the total so every existing read keeps working; the
-- three columns are always written together.

-- 1. Add the columns, defaulted to 0 so existing rows are valid instantly.
ALTER TABLE "users" ADD COLUMN "depositCoins" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN "withdrawableCoins" INTEGER NOT NULL DEFAULT 0;

-- 2. Backfill: every coin anyone already holds becomes a deposit coin.
--
-- Deliberately NOT reconstructed from transaction history. Some of those
-- winnings have already been spent on entries and gifts, so replaying
-- them would hand people a withdrawable balance they no longer have.
-- Starting everyone at zero withdrawable means nobody gains something
-- they didn't earn under the new rules.
UPDATE "users" SET "depositCoins" = "coins", "withdrawableCoins" = 0;
