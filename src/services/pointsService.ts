import { Prisma } from "../generated/prisma";
import prisma from "../config/prisma";
import { computeTeamPoints } from "../utils/teamRules";
import {
  calculateCricketPoints,
  calculateFootballPoints,
  DEFAULT_CRICKET_RULES,
  DEFAULT_FOOTBALL_RULES,
  CricketPointRules,
  FootballPointRules,
} from "../utils/fantasyScoring";

export interface RecalculateResult {
  teamsUpdated: number;
  contestsUpdated: number;
}

// Finds the PointSystem for a match's (sport, format). Falls back to the
// sport's isDefault row, then to the hardcoded DEFAULT_*_RULES if the admin
// hasn't configured anything yet.
export async function resolveRules(sport: "CRICKET" | "FOOTBALL", format: string) {
  const exact = await prisma.pointSystem.findUnique({ where: { sport_format: { sport, format } } });
  if (exact) return exact.rules as unknown as CricketPointRules | FootballPointRules;

  const def = await prisma.pointSystem.findFirst({ where: { sport, isDefault: true } });
  if (def) return def.rules as unknown as CricketPointRules | FootballPointRules;

  return sport === "CRICKET" ? DEFAULT_CRICKET_RULES : DEFAULT_FOOTBALL_RULES;
}

// Just the captain/vice-captain multipliers for a match's (sport, format).
// The mobile app shows these on the captain picker (4.png) and the points
// breakdown (8.jpg), so they must come from the configured PointSystem
// rather than being hardcoded to 2x / 1.5x in the client.
export async function getCaptainMultipliers(
  sport: "CRICKET" | "FOOTBALL",
  format: string
): Promise<{ captainMultiplier: number; viceCaptainMultiplier: number }> {
  const rules = await resolveRules(sport, format);
  return {
    captainMultiplier: rules.captainMultiplier ?? 2,
    viceCaptainMultiplier: rules.viceCaptainMultiplier ?? 1.5,
  };
}

// STEP 1: compute each MatchPlayer.points from its raw stats, using the
// PointSystem configured for the match's (sport, format).
export async function calculateMatchPlayerPoints(matchId: string): Promise<number> {
  const match = await prisma.match.findUniqueOrThrow({ where: { id: matchId } });
  const rules = await resolveRules(match.sport, match.format);

  const matchPlayers = await prisma.matchPlayer.findMany({
    where: { matchId },
    include: { player: true, innings: { orderBy: { inningsNumber: "asc" } } },
  });

  // Collected first, then run as one transaction: a half-scored match
  // is worse than an unscored one.
  const writes: Prisma.PrismaPromise<unknown>[] = [];

  for (const mp of matchPlayers) {
    // Scored per innings and summed, not from the match aggregate.
    //
    // In a Test, a duck in the first innings and eighty in the second
    // are two separate events: aggregating them would hide the duck
    // penalty and award a milestone that wasn't earned in either single
    // innings. Rate-based rules — strike rate, economy — are likewise
    // per innings, which is how they're actually judged.
    //
    // A player with no innings rows falls back to the aggregate, so a
    // squad member whose scorecard was never opened still scores the
    // playing-XI bonus.
    const sources =
      mp.innings.length > 0
        ? mp.innings.map((entry, index) => ({
            entry,
            stats: {
              ...entry,
              // The playing-XI bonus is for being selected, which happens
              // once per match — so only the first innings carries it.
              // Otherwise a Test player would collect it up to four
              // times for the same selection.
              isPlaying: index === 0 ? mp.isPlaying : false,
            },
          }))
        : [{ entry: null, stats: mp }];

    let total = 0;

    for (const source of sources) {
      const points =
        match.sport === "CRICKET"
          ? calculateCricketPoints(source.stats as any, mp.player.role, rules as CricketPointRules)
          : calculateFootballPoints(source.stats as any, mp.player.role, rules as FootballPointRules);

      total += points;

      if (source.entry) {
        writes.push(
          prisma.matchPlayerInnings.update({
            where: { id: source.entry.id },
            data: { points },
          })
        );
      }
    }

    // Float addition drifts (0.1 + 0.2), and these numbers decide payouts.
    total = Math.round(total * 100) / 100;

    writes.push(prisma.matchPlayer.update({ where: { id: mp.id }, data: { points: total } }));
  }

  await prisma.$transaction(writes);

  return matchPlayers.length;
}

/**
 * Rewrites a MatchPlayer's aggregate stats as the sum of its innings.
 *
 * The aggregate stays the single source for anything that reads a
 * player's match totals, so it has to be refreshed whenever an innings
 * scorecard is saved.
 */
export async function syncMatchPlayerAggregate(matchPlayerId: string): Promise<void> {
  const innings = await prisma.matchPlayerInnings.findMany({ where: { matchPlayerId } });

  if (innings.length === 0) return;

  const sum = (pick: (row: (typeof innings)[number]) => number) =>
    innings.reduce((total, row) => total + pick(row), 0);

  await prisma.matchPlayer.update({
    where: { id: matchPlayerId },
    data: {
      runs: sum((r) => r.runs),
      ballsFaced: sum((r) => r.ballsFaced),
      fours: sum((r) => r.fours),
      sixes: sum((r) => r.sixes),
      // Dismissed in ANY innings — the aggregate can't express "out
      // twice", and this flag only feeds displays now that scoring runs
      // per innings.
      isOut: innings.some((r) => r.isOut),

      ballsBowled: sum((r) => r.ballsBowled),
      dotBalls: sum((r) => r.dotBalls),
      maidens: sum((r) => r.maidens),
      runsConceded: sum((r) => r.runsConceded),
      wickets: sum((r) => r.wickets),
      wicketsBowledOrLBW: sum((r) => r.wicketsBowledOrLBW),

      catches: sum((r) => r.catches),
      runOutsDirect: sum((r) => r.runOutsDirect),
      runOutsIndirect: sum((r) => r.runOutsIndirect),
      stumpings: sum((r) => r.stumpings),

      minutesPlayed: sum((r) => r.minutesPlayed),
      goals: sum((r) => r.goals),
      assists: sum((r) => r.assists),
      cleanSheet: innings.some((r) => r.cleanSheet),
      yellowCards: sum((r) => r.yellowCards),
      redCards: sum((r) => r.redCards),
      ownGoals: sum((r) => r.ownGoals),
      penaltiesSaved: sum((r) => r.penaltiesSaved),
      penaltiesMissed: sum((r) => r.penaltiesMissed),
      saves: sum((r) => r.saves),
    },
  });
}

// STEP 2: recompute every UserTeam.totalPoints for a match (captain/VC
// multipliers come from the same PointSystem) from each MatchPlayer's
// current `points`, then refresh rank on every ContestEntry tied to that
// match.
export async function recalculateMatchPoints(matchId: string): Promise<RecalculateResult> {
  const match = await prisma.match.findUniqueOrThrow({ where: { id: matchId } });
  const rules = await resolveRules(match.sport, match.format);
  const captainMultiplier = rules.captainMultiplier ?? 2;
  const viceCaptainMultiplier = rules.viceCaptainMultiplier ?? 1.5;

  const userTeams = await prisma.userTeam.findMany({
    where: { matchId },
    include: { players: { include: { matchPlayer: true } } },
  });

  await prisma.$transaction(
    userTeams.map((team) => {
      const totalPoints = computeTeamPoints(
        team.players.map((utp) => ({ id: utp.matchPlayer.id, points: utp.matchPlayer.points })),
        team.captainId,
        team.viceCaptainId,
        captainMultiplier,
        viceCaptainMultiplier
      );
      return prisma.userTeam.update({ where: { id: team.id }, data: { totalPoints } });
    })
  );

  const contests = await prisma.contest.findMany({ where: { matchId, isCancelled: false } });

  for (const contest of contests) {
    const entries = await prisma.contestEntry.findMany({
      where: { contestId: contest.id },
      include: { userTeam: { select: { totalPoints: true } } },
      // createdAt breaks the tie for DISPLAY ORDER only — whoever joined
      // first is listed first. Without it Postgres returns equal-scoring
      // entries in whatever order it likes, so re-running the scoring
      // could silently reshuffle the leaderboard.
      orderBy: [{ userTeam: { totalPoints: "desc" } }, { createdAt: "asc" }],
    });

    // Standard competition ranking: equal points share a rank, and the
    // next rank skips the places they occupied — 425, 425, 420 gives
    // ranks 1, 1, 3. Two people on the same score always get the same
    // rank, whatever order they happen to be listed in.
    let previousPoints: number | null = null;
    let currentRank = 0;

    const ranked = entries.map((entry, index) => {
      const points = entry.userTeam.totalPoints;
      if (points !== previousPoints) {
        currentRank = index + 1;
        previousPoints = points;
      }
      return { id: entry.id, rank: currentRank };
    });

    await prisma.$transaction(
      ranked.map((entry) =>
        prisma.contestEntry.update({ where: { id: entry.id }, data: { rank: entry.rank } })
      )
    );
  }

  return { teamsUpdated: userTeams.length, contestsUpdated: contests.length };
}
