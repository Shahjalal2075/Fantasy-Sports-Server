# Fantasy Sports Backend (Cricket + Football) — Free-to-Play, Coin-Based

Node.js + TypeScript + Express + PostgreSQL backend, built on **Prisma ORM 7.9**.
No real money anywhere — contests use a virtual, non-purchasable,
non-withdrawable coin system only.

## Stack
- Express + TypeScript, ESM (`"type": "module"`)
- PostgreSQL via **Prisma ORM 7** (`prisma-client` generator, `prisma.config.ts`, pg driver adapter)
- JWT auth (bcrypt), Zod validation
- `tsx` for running TypeScript directly (dev **and** start — see note below)

## Prisma 7 setup notes (read this first)
Prisma 7 changed a lot versus v5/v6:
- The generated client is **not** in `node_modules` anymore — it's generated to `src/generated/prisma` (see `output` in `prisma/schema.prisma`). Import it from `"../generated/prisma/client"`, not `"@prisma/client"`.
- The datasource `url` no longer lives in `schema.prisma` — it's in **`prisma.config.ts`** at the project root.
- `PrismaClient` now **requires a driver adapter** — see `src/config/prisma.ts`, which uses `@prisma/adapter-pg`. `new PrismaClient()` with no arguments will throw.
- Migrations no longer auto-seed. Run `npm run prisma:seed` yourself after your first migration.
- The project is an ES module (`"type": "module"` in `package.json`). Both `npm run dev` and `npm start` use `tsx` (not `node dist/...`) — this sidesteps having to add `.js` extensions to every relative import by hand, which plain `tsc` + Node ESM would otherwise require. `npm run typecheck` runs `tsc --noEmit` for CI/type-safety checks without emitting.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Set up PostgreSQL and update `DATABASE_URL` in `.env`.

3. Change `JWT_SECRET` in `.env` to a long random string.

4. Generate the Prisma client, run the first migration, then seed defaults:
   ```bash
   npx prisma generate
   npx prisma migrate dev --name init
   npm run prisma:seed
   ```
   The seed creates default `PointSystem` rows (CRICKET/Default, FOOTBALL/Default) and `AppSettings` (100-coin daily bonus).

5. Start the dev server:
   ```bash
   npm run dev
   ```
   Server runs at `http://localhost:5000`. Health check: `GET /health`.

## Deploying

The app is structured so the SAME code deploys to either a serverless
platform (Vercel) or a traditional always-on host (Render, a VPS, Docker):
`src/app.ts` builds the Express app with no `.listen()`; `src/index.ts`
(local/traditional hosting) calls `.listen()`, while `api/index.ts`
(Vercel) exports the app directly for Vercel's Node.js runtime to handle.

### Option A — Vercel (serverless)

**Trade-offs to know first:** cold starts (a request after idle time is
slower while the function spins up), a max execution time per request
(10s on the free Hobby plan — see `vercel.json`'s `maxDuration`, raise it
if you upgrade), and no persistent WebSocket/long-lived connections. Fine
for this app's request/response API; not ideal if you later add real-time
features.

1. **Database — use a serverless-friendly Postgres**, not `localhost`.
   [Neon](https://neon.tech) has a genuinely free-forever tier with a
   built-in pooler made for exactly this (serverless functions opening/
   closing connections rapidly):
   - Create a project, copy the **pooled** connection string (the one with
     `-pooler` in the hostname) → this is your `DATABASE_URL`.
   - Copy the **direct** (non-pooled) connection string too → this is your
     `DIRECT_DATABASE_URL` (used only for running migrations).
   - Supabase works too (its pooler is automatic, no separate pooled URL
     needed — you can set `DIRECT_DATABASE_URL` to the same value as
     `DATABASE_URL` in that case).

2. **Push this repo to GitHub**, then in the [Vercel dashboard](https://vercel.com/new):
   - Import the repo. Vercel auto-detects the `/api` function.
   - Add environment variables (Project Settings → Environment Variables):
     `DATABASE_URL`, `DIRECT_DATABASE_URL`, `JWT_SECRET`, `JWT_EXPIRES_IN`,
     `CORS_ORIGIN` (your admin panel's deployed URL), `PRISMA_POOL_MAX=1`.
   - Deploy. `postinstall` runs `prisma generate` automatically as part of
     the build (needs network access to Prisma's engine CDN — Vercel's
     build servers have this, unlike some sandboxed dev environments).

3. **Run migrations + seed** — Vercel doesn't do this for you (and
   shouldn't, automatically, on every deploy). From your own machine, with
   `.env` pointed at the SAME database (use `DIRECT_DATABASE_URL` there):
   ```bash
   npx prisma migrate deploy
   npm run prisma:seed
   ```

4. Your API is live at `https://your-project.vercel.app` — e.g.
   `https://your-project.vercel.app/api/auth/login`. Point the admin
   panel's and mobile app's `VITE_API_URL` / `EXPO_PUBLIC_API_URL` at this.

5. Or deploy from the CLI instead of the dashboard:
   ```bash
   npm install -g vercel
   vercel login
   vercel        # first deploy, follow prompts
   vercel --prod # production deploy
   ```

### Option B — Render (traditional always-on, simpler mental model)

No serverless quirks, no code changes needed — `npm start` just runs
`src/index.ts`, which calls `.listen()` like a normal server. Trade-off:
Render's **free** web services spin down after ~15 minutes of inactivity,
so the first request after a quiet period takes 30-60 seconds to wake up.

1. Database: same as above — use Neon or Supabase's free tier (Render's
   own free Postgres add-on gets **deleted after 30 days**, so don't use
   it for anything you want to keep).
2. [Render dashboard](https://dashboard.render.com) → New → Web Service →
   connect your repo.
   - Build command: `npm install` (triggers `postinstall` → `prisma generate`)
   - Start command: `npm start`
   - Add the same environment variables as the Vercel list above (you can
     set `PRISMA_POOL_MAX` a bit higher here, e.g. `5`, since Render runs
     one long-lived process rather than many parallel invocations).
3. After the first deploy, run `npx prisma migrate deploy` and
   `npm run prisma:seed` from your own machine (same as step 3 above).

### Either way
- `CORS_ORIGIN` should list your deployed admin panel's URL (and anything
  else that calls this API from a browser) once you're past local testing
  — leaving it unset allows all origins, which is fine for development
  but worth tightening for a real deployment.
- The mobile app doesn't need CORS (it's not a browser), just the correct
  `EXPO_PUBLIC_API_URL`.

## Architecture: Team / Player catalog -> Match -> MatchPlayer

This is the core design change from earlier versions:
- **Team** — reusable, created once (e.g. "India"). Has `hasLogo`/`logoUrl` lock pattern.
- **Player** — reusable, belongs to a Team's catalog (e.g. "Shakib Al Hasan" -> Bangladesh). Has `hasPhoto`/`imageUrl` lock pattern, `role`, `creditValue`. Created **once**, not per match.
- **Match** — references `teamAId`/`teamBId` (from the catalog), plus `tournamentName`, `format`, `venue`, `startTime`/`lockTime`.
- **MatchPlayer** — the join between a Match and a catalog Player: "this player is part of this match." Holds `isPlaying` (Playing XI in/out) and **all the raw performance stats** (runs, balls faced, wickets, catches, etc. for cricket; goals, assists, cards, etc. for football) plus the computed `points` for that match. This is what "Add Player" to a match actually creates (by selecting an existing catalog Player), and what the manual scorecard form updates.
- **UserTeam / UserTeamPlayer** — a user's fantasy XI now selects **MatchPlayer** rows (not Player rows directly), since eligibility/points are match-specific.

## Team Catalog Endpoints

| Method | Endpoint                              | Auth  | Description                                  |
|--------|-------------------------------------------|-------|---------------------------------------------------|
| GET    | /api/team-catalog?sport=                   | No    | List teams                                          |
| POST   | /api/team-catalog                           | Admin | Create a team                                        |
| PATCH  | /api/team-catalog/:id                       | Admin | Update a team                                         |
| DELETE | /api/team-catalog/:id                       | Admin | Delete (blocked if used in a match)                    |
| GET    | /api/team-catalog/:id/players                | No    | **Team Detail Mode -> Players tab**                     |
| GET    | /api/team-catalog/:id/recent-matches         | No    | **Team Detail Mode -> Recent Match tab**                |

## Player Catalog Endpoints

| Method | Endpoint            | Auth  | Description                                             |
|--------|------------------------|-------|----------------------------------------------------------|
| POST   | /api/players             | Admin | Create a player in a team's catalog (`teamId` required)    |
| PATCH  | /api/players/:id          | Admin | Edit catalog details (name, role, credit, photo)            |
| DELETE | /api/players/:id          | Admin | Delete (blocked if already added to a match)                 |

**Photo/Logo URL lock pattern** (Team and Player both): `hasPhoto`/`hasLogo: false` (default) forces the URL field to `""` server-side. Set the flag `true` + a real URL together to attach one — this can't be bypassed by the client.

## Match Endpoints

| Method | Endpoint                          | Auth  | Description                                     |
|--------|---------------------------------------|-------|------------------------------------------------------|
| GET    | /api/matches?sport=&status=            | No    | List matches                                            |
| GET    | /api/matches/:id                       | No    | Match detail                                              |
| POST   | /api/matches                            | Admin | Create — `teamAId`, `teamBId`, `tournamentName`, `format`, `startTime`, `venue?`  |
| PATCH  | /api/matches/:id                        | Admin | Update                                                     |
| DELETE | /api/matches/:id                        | Admin | Delete                                                      |
| POST   | /api/matches/:id/calculate-points        | Admin | Raw stats -> MatchPlayer.points -> team totals -> ranks       |
| POST   | /api/matches/:id/sync-live-score         | Admin | Optional automated stats pull (see below)                      |

### Adding players to a match (from the catalog)

| Method | Endpoint                                        | Auth  | Description                                                    |
|--------|------------------------------------------------------|-------|-----------------------------------------------------------------------|
| GET    | /api/matches/:matchId/players                          | No    | Squad actually in this match (with stats + points)                       |
| GET    | /api/matches/:matchId/available-players                 | Admin | Catalog players from the match's 2 teams, not yet added — powers "Add Player" |
| POST   | /api/matches/:matchId/players                            | Admin | Add a catalog player (`{ playerId }`) to this match                        |
| PATCH  | /api/matches/:matchId/players/:matchPlayerId               | Admin | Playing XI toggle AND/OR the manual scorecard fields (see below)              |
| DELETE | /api/matches/:matchId/players/:matchPlayerId               | Admin | Remove a player from this match                                                |

### Sync Live Score — manual scorecard entry (the primary workflow)

`PATCH /api/matches/:matchId/players/:matchPlayerId` accepts any subset of:
```json
{
  "isPlaying": true,
  "runs": 45, "ballsFaced": 32, "fours": 5, "sixes": 1, "isOut": true,
  "ballsBowled": 24, "dotBalls": 10, "maidens": 1, "runsConceded": 28, "wickets": 2,
  "catches": 1, "runOutsDirect": 0, "runOutsIndirect": 1, "stumpings": 0
}
```
(Football uses `minutesPlayed`, `goals`, `assists`, `cleanSheet`, `yellowCards`, `redCards`, `ownGoals`, `penaltiesSaved`, `penaltiesMissed`, `saves` instead.)

The admin panel's "Sync Live Score" screen calls `GET /api/matches/:matchId/players` to show the squad, lets the admin fill in each player's stats, `PATCH`es each one, then calls `POST /api/matches/:id/calculate-points` to turn those raw stats into fantasy points using the configured **PointSystem**.

### Optional: automated provider sync
`sync-live-score` also still supports an external data provider (mock or real HTTP) for auto-filling stats — see `src/services/providers/`. This is a secondary path; manual entry above is the primary one this app is built around.

## Point System (admin-configurable scoring)

Rebuilt to match a detailed scoring sheet exactly — supports run/wicket
milestone tiers, strike-rate bands, economy-rate bands, and a
Bowled/LBW-specific bonus (not just flat per-action weights).

| Method | Endpoint               | Auth  | Description                                          |
|--------|---------------------------|-------|--------------------------------------------------------|
| GET    | /api/point-systems?sport=   | No    | List configured scoring rules                            |
| GET    | /api/point-systems/defaults  | No    | Built-in presets **per format** (see below)                |
| POST   | /api/point-systems           | Admin | Create a rule set for a `(sport, format)` pair                |
| PATCH  | /api/point-systems/:id        | Admin | Edit a rule set                                                 |
| DELETE | /api/point-systems/:id        | Admin | Delete a rule set                                                 |

Seeded out of the box (`npm run prisma:seed`) — 5 cricket formats matching
the provided scoring sheet exactly, **T20 marked as the cricket default**:

- **T20**, **ODI**, **Test**, **T10**, **H100** (The Hundred)
- **Football** — one `Default` rule set (flat weights, no tiered bands — football doesn't need SR/economy-style bands)

Each match's `format` should match a `PointSystem.format` for that sport
(e.g. a match with `format: "T20"` uses the T20 rules). If no exact match
exists, the sport's `isDefault: true` row is used; if none of those exist
either, hardcoded fallbacks in `src/utils/fantasyScoring.ts` are used.

### Rules shape (`CricketPointRules` in `fantasyScoring.ts`)
Two kinds of fields:
- **Flat weights** — `perRun`, `perFour`, `perSix`, `perWicket`, `perMaiden`, `lbwBowledBonus`, `perCatch`, `threeCatchBonus`, `perStumping`, `perRunOutDirect`, `perRunOutIndirect`, `duckPenalty`, `dotBallBonusPoints` + `dotBallsPerBonus` (e.g. 1 = every dot ball, 3 = every 3 dot balls), `playingXIBonus`, `captainMultiplier`, `viceCaptainMultiplier`.
- **Tiered arrays** — `runMilestones` and `wicketHaulBonuses` are `{ threshold, bonus }[]`; only the **highest threshold reached** applies (not cumulative). `strikeRateBands` and `economyBands` are `{ min, max, points }[]` (use `9999` as `max` for "and above"), gated by `srQualifyMinRuns`/`srQualifyMinBalls` (either qualifies) and `economyQualifyMinOvers`. Test and H100 have empty band arrays since those formats don't score strike rate / economy in the sheet.

**Captain/Vice-captain multipliers are now per-PointSystem** (not hardcoded
2x/1.5x globally) — `recalculateMatchPoints()` reads them from the match's
resolved rules.

### New MatchPlayer field: `wicketsBowledOrLBW`
Separate from total `wickets` — the sheet gives an extra flat bonus
specifically for wickets taken Bowled or LBW. Fill this in alongside
`wickets` on the manual scorecard (admin panel's "Fill scorecard" already
has this field).

The admin panel's Point System screen renders flat weights as a plain
number-input grid, and the milestone/band arrays as add/remove row editors
— matching the sheet's structure directly.

## Team-Building & Contest Endpoints
Fantasy team selection uses **MatchPlayer** ids, not raw Player ids:
```json
POST /api/teams
{
  "matchId": "...",
  "matchPlayerIds": ["<11 MatchPlayer uuids>"],
  "captainId": "<one of the 11>",
  "viceCaptainId": "<a different one>"
}
```

| Method | Endpoint                       | Auth  | Description                                                    |
|--------|------------------------------------|-------|----------------------------------------------------------------------|
| GET    | /api/contests?matchId=&hideFull=    | No    | List contests for a match. `hideFull=true` (mobile app) hides full/cancelled ones |
| GET    | /api/contests/:id                    | No    | Contest detail, includes `isFull`/`isCancelled`                          |
| POST   | /api/contests/:id/join                | Yes   | `{ userTeamId }` — one entry per **user** per contest (any team), blocked once full/locked/cancelled |
| GET    | /api/contests/:id/leaderboard          | No    | Ranked entries                                                             |
| POST   | /api/contests                          | Admin | Create — `entryCost` has no cap                                             |
| POST   | /api/contests/:id/distribute-prizes     | Admin | Pay coin prizes to winning ranks (once only)                                  |
| POST   | /api/contests/:id/cancel                | Admin | Only allowed while **not full** — refunds every joined user's entry coins, marks cancelled |

**Auto Upcoming → Live:** a match's `status` in API responses automatically
shows `"LIVE"` once `lockTime` has passed (even if the DB row still says
`UPCOMING`) — no cron job needed. Admins still explicitly mark matches
`COMPLETED`/`CANCELLED`. This means `GET /api/matches?status=LIVE` reflects
reality even between admin actions.

## Virtual Coins (still NOT real money)

- Daily bonus amount is admin-configurable via `GET`/`PATCH /api/admin/settings` (`dailyBonusAmount`). Claimed via `POST /api/wallet/claim-daily-bonus`, once per UTC day.
- Contests cost coins to join (`entryCost`, no cap) and pay coins to winners (`prizeDistribution`).
- Cancelling a non-full contest refunds every joined user's entry cost (`CONTEST_REFUND` transaction type).
- Promo codes (below) are another way to earn coins.

## Promo Codes

| Method | Endpoint                | Auth  | Description                                                          |
|--------|----------------------------|-------|--------------------------------------------------------------------------|
| POST   | /api/promo-codes/claim       | Yes   | `{ code }` — credits coins once per user, per code                          |
| GET    | /api/promo-codes              | Admin | List all codes with live claim counts + expired flag                          |
| POST   | /api/promo-codes               | Admin | `{ code, coinAmount, maxClaims, validDays }` — `expiresAt` computed from `validDays` at creation |
| PATCH  | /api/promo-codes/:id             | Admin | `{ isActive }` — disable early                                                  |
| DELETE | /api/promo-codes/:id             | Admin | Delete                                                                            |

A code stops working once `maxClaims` is hit, `expiresAt` passes, or an
admin disables it — checked in that order on every claim attempt.

## Admin: Users, Bonus/Fine/Ban, Audit Log

| Method | Endpoint                     | Auth  | Description                                             |
|--------|----------------------------------|-------|-----------------------------------------------------------|
| GET    | /api/admin/users                   | Admin | Every user: joined date, coins, matches played, contests joined, banned status |
| GET    | /api/admin/users/:id                 | Admin | Full detail for one user: profile, coin/win/bonus/fine totals, full contest participation history |
| POST   | /api/admin/users/:id/bonus           | Admin | `{ amount, reason }` — credits coins, creates a Notification |
| POST   | /api/admin/users/:id/fine             | Admin | `{ amount, reason }` — debits coins (clamped at 0), creates a Notification |
| POST   | /api/admin/users/:id/ban               | Admin | `{ reason? }` — blocks login and all authenticated requests |
| POST   | /api/admin/users/:id/unban              | Admin | Restores access                                               |
| GET/PATCH | /api/admin/settings                  | Admin | `{ dailyBonusAmount }`                                          |
| GET    | /api/admin/coin-adjustments             | Admin | Audit log of every bonus/fine ever given, across all users, most recent first |

## User Notifications (bonus/fine/ban alerts)

| Method | Endpoint                | Auth | Description                          |
|--------|----------------------------|------|----------------------------------------|
| GET    | /api/notifications           | Yes  | The user's own alerts + unread count      |
| PATCH  | /api/notifications/:id/read    | Yes  | Mark one as read                            |

Whenever an admin gives a bonus, fine, or ban, a `Notification` row is
created automatically so the user can see exactly what happened and why
(the `reason` the admin typed) — no confusion about balance changes.

## A note on this sandbox
Prisma's engine binaries (`binaries.prisma.sh`) aren't reachable from this
build sandbox, so `prisma generate` couldn't be run here to fully
type-check every file end-to-end. Everything was written and reviewed
carefully against the schema, but run `npx prisma generate` on your own
machine first thing, then `npm run typecheck`, and let me know if anything
surfaces.

## Schema changes in this version — remember to migrate
Several fields/models were added on top of an already-deployed schema:
`User.username` (required, unique), `User.referredByCode`, `Contest.isCancelled`,
`ContestEntry`'s unique constraint changed from `(contestId, userTeamId)` to
`(contestId, userId)`, `CoinTransactionType` gained `CONTEST_REFUND` and
`PROMO_CODE`, and two new models: `PromoCode` / `PromoCodeClaim`.

**If you already have real user rows in your database**, adding a
required+unique `username` column will make `prisma migrate deploy` fail
until every existing row has one. Either clear the `users` table first (fine
for a dev/test database with no real users yet), or ask for a migration
script that backfills a generated username per existing user before the
column becomes required.
