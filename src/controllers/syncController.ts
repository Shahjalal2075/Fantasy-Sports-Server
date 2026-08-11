import { Request, Response } from "express";
import prisma from "../config/prisma";
import { getSportsDataProvider } from "../services/providerFactory";
import { calculateMatchPlayerPoints, recalculateMatchPoints } from "../services/pointsService";

// POST /api/matches/:id/sync-live-score  (admin only)
// OPTIONAL automation path: pulls stats from the configured sports-data
// provider (defaults to a mock provider — see README), matches players by
// name, writes those raw stats onto each MatchPlayer, then recalculates
// points and the leaderboard. The PRIMARY workflow for this app is manual
// entry via PATCH /api/matches/:matchId/players/:matchPlayerId instead —
// this endpoint exists for when a real live-score API is wired up later.
export async function syncLiveScore(req: Request, res: Response) {
  const { id: matchId } = req.params as { id: string };
  const { externalMatchId } = req.body as { externalMatchId?: string };

  const match = await prisma.match.findUnique({
    where: { id: matchId },
    include: { matchPlayers: { include: { player: true } } },
  });
  if (!match) {
    return res.status(404).json({ error: "Match not found" });
  }

  const provider = getSportsDataProvider();

  let externalData;
  try {
    externalData = await provider.fetchMatchStats(externalMatchId ?? matchId, match.sport);
  } catch (err: any) {
    return res.status(502).json({ error: `Failed to fetch live score data: ${err.message}` });
  }

  const nameToMatchPlayer = new Map(match.matchPlayers.map((mp) => [mp.player.name.trim().toLowerCase(), mp]));

  let updatedCount = 0;
  const unmatchedNames: string[] = [];

  await prisma.$transaction(async (tx) => {
    for (const line of externalData.players) {
      const matchPlayer = nameToMatchPlayer.get(line.playerName.trim().toLowerCase());
      if (!matchPlayer) {
        unmatchedNames.push(line.playerName);
        continue;
      }

      if (match.sport === "CRICKET" && line.cricketStats) {
        await tx.matchPlayer.update({ where: { id: matchPlayer.id }, data: line.cricketStats });
        updatedCount++;
      } else if (match.sport === "FOOTBALL" && line.footballStats) {
        await tx.matchPlayer.update({ where: { id: matchPlayer.id }, data: line.footballStats });
        updatedCount++;
      }
    }
  });

  const newStatus = externalData.isMatchComplete
    ? "COMPLETED"
    : match.status === "UPCOMING"
    ? "LIVE"
    : match.status;
  if (newStatus !== match.status) {
    await prisma.match.update({ where: { id: matchId }, data: { status: newStatus as any } });
  }

  const playersScored = await calculateMatchPlayerPoints(matchId);
  const recalcResult = await recalculateMatchPoints(matchId);

  return res.status(200).json({
    message: "Live score synced",
    playersUpdated: updatedCount,
    unmatchedPlayerNames: unmatchedNames,
    matchStatus: newStatus,
    isMatchComplete: externalData.isMatchComplete,
    playersScored,
    ...recalcResult,
  });
}
