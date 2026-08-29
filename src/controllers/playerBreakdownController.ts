import { Request, Response } from "express";
import prisma from "../config/prisma";
import { resolveRules } from "../services/pointsService";
import {
  explainCricketPoints,
  explainFootballPoints,
  CricketPointRules,
  FootballPointRules,
} from "../utils/fantasyScoring";

/**
 * GET /api/matches/:matchId/players/:matchPlayerId/breakdown?contestId=…
 *
 * The per-event scorecard behind a single player's points — what they
 * did, and what each piece was worth.
 *
 * `contestId` is optional and only used for the "selected by" figure,
 * which is meaningful relative to a contest rather than globally.
 */
export async function getPlayerBreakdown(req: Request, res: Response) {
  const { matchId, matchPlayerId } = req.params as { matchId: string; matchPlayerId: string };
  const contestId = typeof req.query.contestId === "string" ? req.query.contestId : null;

  const matchPlayer = await prisma.matchPlayer.findFirst({
    where: { id: matchPlayerId, matchId },
    include: {
      player: { include: { team: { select: { shortName: true, name: true } } } },
      match: true,
    },
  });

  if (!matchPlayer) {
    return res.status(404).json({ error: "Player not found in this match" });
  }

  const match = matchPlayer.match;

  // Same guard as the team breakdown: nobody's scorecard is visible
  // until the match has been under way for a few minutes, so a player's
  // detail can't be used to infer lineups while teams are still open.
  const BREAKDOWN_DELAY_MS = 5 * 60 * 1000;
  const liveSince = match.lockTime.getTime();
  const windowOpen =
    match.status === "COMPLETED" ||
    (match.status !== "CANCELLED" && Date.now() >= liveSince + BREAKDOWN_DELAY_MS);

  const viewer = await prisma.user.findUnique({
    where: { id: req.userId as string },
    select: { isAdmin: true },
  });

  if (!windowOpen && !viewer?.isAdmin) {
    return res.status(403).json({
      error: "Player points open a few minutes after the match goes live",
      availableAt: new Date(liveSince + BREAKDOWN_DELAY_MS),
    });
  }

  const rules = await resolveRules(match.sport, match.format);

  const events =
    match.sport === "CRICKET"
      ? explainCricketPoints(
          {
            isPlaying: matchPlayer.isPlaying,
            runs: matchPlayer.runs,
            ballsFaced: matchPlayer.ballsFaced,
            fours: matchPlayer.fours,
            sixes: matchPlayer.sixes,
            isOut: matchPlayer.isOut,
            ballsBowled: matchPlayer.ballsBowled,
            dotBalls: matchPlayer.dotBalls,
            maidens: matchPlayer.maidens,
            runsConceded: matchPlayer.runsConceded,
            wickets: matchPlayer.wickets,
            wicketsBowledOrLBW: matchPlayer.wicketsBowledOrLBW,
            catches: matchPlayer.catches,
            runOutsDirect: matchPlayer.runOutsDirect,
            runOutsIndirect: matchPlayer.runOutsIndirect,
            stumpings: matchPlayer.stumpings,
          },
          matchPlayer.player.role,
          rules as CricketPointRules
        )
      : explainFootballPoints(
          {
            isPlaying: matchPlayer.isPlaying,
            minutesPlayed: matchPlayer.minutesPlayed,
            goals: matchPlayer.goals,
            assists: matchPlayer.assists,
            cleanSheet: matchPlayer.cleanSheet,
            yellowCards: matchPlayer.yellowCards,
            redCards: matchPlayer.redCards,
            ownGoals: matchPlayer.ownGoals,
            penaltiesSaved: matchPlayer.penaltiesSaved,
            penaltiesMissed: matchPlayer.penaltiesMissed,
            saves: matchPlayer.saves,
          },
          matchPlayer.player.role,
          rules as FootballPointRules
        );

  // How many entrants in this contest picked this player. Counted from
  // the entries rather than from all teams for the match, because that's
  // the pool the viewer is actually competing against.
  let selectedByPercent: number | null = null;

  if (contestId) {
    const [totalEntries, pickedCount] = await Promise.all([
      prisma.contestEntry.count({ where: { contestId } }),
      prisma.contestEntry.count({
        where: {
          contestId,
          userTeam: { players: { some: { matchPlayerId } } },
        },
      }),
    ]);

    if (totalEntries > 0) {
      selectedByPercent = Math.round((pickedCount / totalEntries) * 1000) / 10;
    }
  }

  return res.status(200).json({
    player: {
      matchPlayerId: matchPlayer.id,
      name: matchPlayer.player.name,
      role: matchPlayer.player.role,
      teamShortName: matchPlayer.player.team?.shortName ?? "",
      hasPhoto: matchPlayer.player.hasPhoto,
      imageUrl: matchPlayer.player.imageUrl,
      credits: matchPlayer.player.creditValue,
      isPlaying: matchPlayer.isPlaying,
      // The stored total, not a re-sum of the lines — so the screen can
      // never disagree with the leaderboard.
      points: matchPlayer.points,
    },
    selectedByPercent,
    events,
  });
}
