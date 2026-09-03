import { Request, Response } from "express";
import prisma from "../config/prisma";
import { syncMatchPlayerAggregate } from "../services/pointsService";
import {
  addMatchPlayerSchema,
  updateMatchPlayerSchema,
  savePlayerInningsSchema,
} from "../utils/validators";

// GET /api/matches/:matchId/players  (public)
// The squad actually added to this match, with live stats + computed points.
export async function listMatchPlayers(req: Request, res: Response) {
  const { matchId } = req.params as { matchId: string };

  const matchPlayers = await prisma.matchPlayer.findMany({
    where: { matchId },
    include: { player: { include: { team: true } } },
    orderBy: [{ player: { teamId: "asc" } }, { player: { role: "asc" } }],
  });

  return res.status(200).json({ matchPlayers });
}

// GET /api/matches/:matchId/available-players  (admin only)
// Catalog players belonging to either of the match's two teams who have
// NOT yet been added to this match — powers the "Add Player" select list.
export async function listAvailablePlayers(req: Request, res: Response) {
  const { matchId } = req.params as { matchId: string };

  const match = await prisma.match.findUnique({ where: { id: matchId } });
  if (!match) {
    return res.status(404).json({ error: "Match not found" });
  }

  const alreadyAdded = await prisma.matchPlayer.findMany({ where: { matchId }, select: { playerId: true } });
  const addedIds = new Set(alreadyAdded.map((mp) => mp.playerId));

  const candidates = await prisma.player.findMany({
    where: { teamId: { in: [match.teamAId, match.teamBId] } },
    include: { team: true },
    orderBy: { name: "asc" },
  });

  const available = candidates.filter((p) => !addedIds.has(p.id));

  return res.status(200).json({ players: available });
}

// POST /api/matches/:matchId/players  (admin only)  body: { playerId }
// Adds a catalog player to this match (creates the MatchPlayer row that
// the manual scorecard will later fill in).
export async function addMatchPlayer(req: Request, res: Response) {
  const { matchId } = req.params as { matchId: string };

  const parsed = addMatchPlayerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }
  const { playerId } = parsed.data;

  const match = await prisma.match.findUnique({ where: { id: matchId } });
  if (!match) {
    return res.status(404).json({ error: "Match not found" });
  }

  const player = await prisma.player.findUnique({ where: { id: playerId } });
  if (!player) {
    return res.status(404).json({ error: "Player not found" });
  }
  if (player.teamId !== match.teamAId && player.teamId !== match.teamBId) {
    return res.status(400).json({ error: "This player's team isn't playing in this match" });
  }

  try {
    const matchPlayer = await prisma.matchPlayer.create({
      data: { matchId, playerId },
      include: { player: { include: { team: true } } },
    });
    return res.status(201).json({ matchPlayer });
  } catch (err: any) {
    if (err.code === "P2002") {
      return res.status(409).json({ error: "This player has already been added to this match" });
    }
    throw err;
  }
}

// PATCH /api/matches/:matchId/players/:matchPlayerId  (admin only)
// Used for both the quick "Playing XI in/out" toggle AND the manual
// scorecard form (runs, balls, wickets, catches, etc.) — any subset of
// fields can be sent.
export async function updateMatchPlayer(req: Request, res: Response) {
  const { matchPlayerId } = req.params as { matchPlayerId: string };

  const parsed = updateMatchPlayerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const existing = await prisma.matchPlayer.findUnique({ where: { id: matchPlayerId } });
  if (!existing) {
    return res.status(404).json({ error: "This player is not part of this match" });
  }

  const matchPlayer = await prisma.matchPlayer.update({
    where: { id: matchPlayerId },
    data: parsed.data,
    include: { player: { include: { team: true } } },
  });

  return res.status(200).json({ matchPlayer });
}

// GET /api/matches/:matchId/players/:matchPlayerId/innings   (admin)
export async function listPlayerInnings(req: Request, res: Response) {
  const { matchPlayerId } = req.params as { matchPlayerId: string };

  const innings = await prisma.matchPlayerInnings.findMany({
    where: { matchPlayerId },
    orderBy: { inningsNumber: "asc" },
  });

  return res.status(200).json({ innings });
}

// PUT /api/matches/:matchId/players/:matchPlayerId/innings   (admin)
//
// Replaces the whole set of innings for one player. Sent as a unit
// because the admin edits a player's full scorecard at once, and it
// keeps innings numbering free of gaps.
export async function savePlayerInnings(req: Request, res: Response) {
  const { matchPlayerId } = req.params as { matchPlayerId: string };

  const parsed = savePlayerInningsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const existing = await prisma.matchPlayer.findUnique({ where: { id: matchPlayerId } });
  if (!existing) {
    return res.status(404).json({ error: "This player is not part of this match" });
  }

  const seen = new Set<number>();
  for (const entry of parsed.data.innings) {
    if (seen.has(entry.inningsNumber)) {
      return res.status(400).json({ error: "Two entries share the same innings number" });
    }
    seen.add(entry.inningsNumber);
  }

  await prisma.$transaction(async (tx) => {
    await tx.matchPlayerInnings.deleteMany({ where: { matchPlayerId } });

    if (parsed.data.innings.length > 0) {
      await tx.matchPlayerInnings.createMany({
        data: parsed.data.innings.map((entry) => ({ ...entry, matchPlayerId })),
      });
    }
  });

  // The aggregate on MatchPlayer is what the rest of the app reads, so
  // it has to be rebuilt from the innings just written. Points stay
  // stale until an admin runs Calculate Points, same as before.
  await syncMatchPlayerAggregate(matchPlayerId);

  const innings = await prisma.matchPlayerInnings.findMany({
    where: { matchPlayerId },
    orderBy: { inningsNumber: "asc" },
  });

  return res.status(200).json({ innings });
}

// DELETE /api/matches/:matchId/players/:matchPlayerId  (admin only)
export async function removeMatchPlayer(req: Request, res: Response) {
  const { matchPlayerId } = req.params as { matchPlayerId: string };

  const existing = await prisma.matchPlayer.findUnique({ where: { id: matchPlayerId } });
  if (!existing) {
    return res.status(404).json({ error: "This player is not part of this match" });
  }

  try {
    await prisma.matchPlayer.delete({ where: { id: matchPlayerId } });
  } catch (err: any) {
    if (err.code === "P2003") {
      return res.status(409).json({ error: "Cannot remove — this player has already been picked into user fantasy teams" });
    }
    throw err;
  }

  return res.status(200).json({ message: "Player removed from match" });
}
