-- A pairing is only "connected" once the live service confirms it.
--
-- The column defaulted to true, so a code typed in by an admin showed as
-- connected immediately — before the live side had ever reported that
-- player. The default is now false; the live service sets it true when
-- it sends the code back during a connect.
ALTER TABLE "player_live_links" ALTER COLUMN "isActive" SET DEFAULT false;

-- Existing rows are left alone: any that are genuinely connected will be
-- confirmed again on the next connect, and any that aren't were showing
-- the wrong state anyway and will correct themselves.
