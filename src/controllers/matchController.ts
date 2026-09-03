import { Request, Response } from "express";
import prisma from "../config/prisma";
import { createMatchSchema, updateMatchSchema } from "../utils/validators";
import { calculateMatchPlayerPoints, recalculateMatchPoints, getCaptainMultipliers } from "../services/pointsService";

// A match's status is only ever moved to COMPLETED/CANCELLED explicitly by
// an admin, but UPCOMING -> LIVE happens automatically once the lock time
// passes — computed on every read rather than needing a background job.
// The stored `status` column is left untouched; this is purely a response
// override.
function withEffectiveStatus<T extends { status: string; lockTime: Date }>(match: T): T {
  if (match.status === "UPCOMING" && new Date() >= match.lockTime) {
    return { ...match, status: "LIVE" };
  }
  return match;
}

// ---------- Public endpoints ----------

// GET /api/matches?sport=CRICKET&status=UPCOMING
export async function listMatches(req: Request, res: Response) {
  const { sport, status } = req.query;

  // Status filtering happens AFTER computing effective status (below),
  // since a match that's UPCOMING in the DB may now be effectively LIVE.
  const matches = await prisma.match.findMany({
    where: {
      sport: sport ? (sport as any) : undefined,
    },
    include: {
      teamA: true,
      teamB: true,
      // Just enough for the admin list's Server column — one query
      // rather than a lookup per row.
      liveLink: { select: { code: true, liveMatchId: true, lastScoreAt: true } },
    },
    orderBy: { startTime: "asc" },
  });

  let withStatus = matches.map((match: any) => ({
    ...withEffectiveStatus(match),
    liveConnected: !!match.liveLink?.liveMatchId,
    liveCode: match.liveLink?.code ?? null,
    liveLastScoreAt: match.liveLink?.lastScoreAt ?? null,
  }));
  if (status) {
    withStatus = withStatus.filter((m) => m.status === status);
  }

  return res.status(200).json({ matches: withStatus });
}

// GET /api/matches/:id
export async function getMatchById(req: Request, res: Response) {
  const { id } = req.params as { id: string };

  const match = await prisma.match.findUnique({
    where: { id },
    include: { teamA: true, teamB: true },
  });

  if (!match) {
    return res.status(404).json({ error: "Match not found" });
  }

  // The captain picker (4.png) and points breakdown (8.jpg) show these as
  // badges, so they ship with the match rather than being hardcoded
  // client-side — an admin can change them per PointSystem.
  const multipliers = await getCaptainMultipliers(match.sport, match.format);

  return res.status(200).json({ match: { ...withEffectiveStatus(match), ...multipliers } });
}

// ---------- Admin endpoints ----------

// POST /api/matches  (admin only)
export async function createMatch(req: Request, res: Response) {
  const parsed = createMatchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const data = parsed.data;

  const [teamA, teamB] = await Promise.all([
    prisma.team.findUnique({ where: { id: data.teamAId } }),
    prisma.team.findUnique({ where: { id: data.teamBId } }),
  ]);
  if (!teamA || !teamB) {
    return res.status(404).json({ error: "One or both selected teams do not exist" });
  }
  if (teamA.sport !== data.sport || teamB.sport !== data.sport) {
    return res.status(400).json({ error: "Both teams must match the selected sport" });
  }

  const match = await prisma.match.create({
    data: {
      sport: data.sport,
      teamAId: data.teamAId,
      teamBId: data.teamBId,
      tournamentName: data.tournamentName,
      format: data.format,
      venue: data.venue,
      startTime: new Date(data.startTime),
      // Default lockTime to startTime if not explicitly provided
      lockTime: new Date(data.lockTime ?? data.startTime),
    },
    include: { teamA: true, teamB: true },
  });

  return res.status(201).json({ match });
}

// PATCH /api/matches/:id  (admin only)
export async function updateMatch(req: Request, res: Response) {
  const { id } = req.params as { id: string };

  const parsed = updateMatchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const existing = await prisma.match.findUnique({ where: { id } });
  if (!existing) {
    return res.status(404).json({ error: "Match not found" });
  }

  const data = parsed.data;

  // If the admin updates startTime without also sending a separate
  // lockTime, keep lockTime in sync with it (same default as create) —
  // otherwise lockTime silently goes stale and both the countdown display
  // and the actual join/team-lock enforcement use the wrong time.
  const nextLockTime = data.lockTime
    ? new Date(data.lockTime)
    : data.startTime
    ? new Date(data.startTime)
    : undefined;

  const match = await prisma.match.update({
    where: { id },
    data: {
      ...data,
      startTime: data.startTime ? new Date(data.startTime) : undefined,
      lockTime: nextLockTime,
    },
    include: { teamA: true, teamB: true },
  });

  return res.status(200).json({ match });
}

// DELETE /api/matches/:id  (admin only)
export async function deleteMatch(req: Request, res: Response) {
  const { id } = req.params as { id: string };

  const existing = await prisma.match.findUnique({ where: { id } });
  if (!existing) {
    return res.status(404).json({ error: "Match not found" });
  }

  await prisma.match.delete({ where: { id } });

  return res.status(200).json({ message: "Match deleted" });
}

// POST /api/matches/:id/calculate-points  (admin only)
// Run this after uploading each player's final `points` for the match
// (via PATCH /api/players/:id). Recomputes every UserTeam's totalPoints
// (captain 2x, vice-captain 1.5x) and refreshes rank on every ContestEntry
// tied to this match.
export async function recalculatePoints(req: Request, res: Response) {
  const { id: matchId } = req.params as { id: string };

  const match = await prisma.match.findUnique({ where: { id: matchId } });
  if (!match) {
    return res.status(404).json({ error: "Match not found" });
  }

  // Step 1: raw stats -> each MatchPlayer.points (using the configured PointSystem)
  const playersScored = await calculateMatchPlayerPoints(matchId);
  // Step 2: MatchPlayer.points -> UserTeam.totalPoints + ContestEntry.rank
  const result = await recalculateMatchPoints(matchId);

  // Stamp when the numbers actually moved. The app surfaces this as the
  // leaderboard's "Last Updated", which previously just showed whenever
  // the user happened to open the screen.
  const pointsCalculatedAt = new Date();
  await prisma.match.update({ where: { id: matchId }, data: { pointsCalculatedAt } });

  return res
    .status(200)
    .json({ message: "Points recalculated", playersScored, pointsCalculatedAt, ...result });
}
