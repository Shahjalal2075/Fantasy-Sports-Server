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
    include: { player: true },
  });

  await prisma.$transaction(
    matchPlayers.map((mp) => {
      const points =
        match.sport === "CRICKET"
          ? calculateCricketPoints(mp, mp.player.role, rules as CricketPointRules)
          : calculateFootballPoints(mp, mp.player.role, rules as FootballPointRules);
      return prisma.matchPlayer.update({ where: { id: mp.id }, data: { points } });
    })
  );

  return matchPlayers.length;
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
      orderBy: { userTeam: { totalPoints: "desc" } },
    });

    await prisma.$transaction(
      entries.map((entry, index) =>
        prisma.contestEntry.update({ where: { id: entry.id }, data: { rank: index + 1 } })
      )
    );
  }

  return { teamsUpdated: userTeams.length, contestsUpdated: contests.length };
}
