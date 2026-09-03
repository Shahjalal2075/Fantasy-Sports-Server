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

  // Points are scored from innings rows whenever any exist, so a stat
  // written only to this aggregate would be stored and then ignored.
  // Mirror anything beyond isPlaying into the first innings.
  //
  // isPlaying is excluded deliberately: it belongs to the match, not to
  // an innings, and the scorer reads it from here.
  const { isPlaying, ...stats } = parsed.data as Record<string, unknown>;

  if (Object.keys(stats).length > 0) {
    const hasInnings = await prisma.matchPlayerInnings.findFirst({
      where: { matchPlayerId },
      select: { id: true },
    });

    if (hasInnings) {
      await prisma.matchPlayerInnings.update({
        where: { matchPlayerId_inningsNumber: { matchPlayerId, inningsNumber: 1 } },
        data: stats,
      }).catch(async () => {
        // No innings 1 (a Test edited from innings 2 onwards): create it
        // rather than losing the edit.
        await prisma.matchPlayerInnings.create({
          data: { matchPlayerId, inningsNumber: 1, ...stats },
        });
      });

      await syncMatchPlayerAggregate(matchPlayerId);
    }
  }

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

/**
 * PUT /api/matches/:matchId/players/:matchPlayerId/innings   (admin)
 *
 * Merges the innings sent. Innings not mentioned are untouched, and
 * within an innings only the fields present are written.
 *
 * Deliberately not a replace. An admin editing one innings — or one
 * field — must not wipe the rest, and the fields the live feed can't
 * supply (dot balls, the bowled/LBW split) live here too: replacing the
 * row would erase them every time anything else was saved.
 */
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

  for (const entry of parsed.data.innings) {
    const { inningsNumber, ...stats } = entry;

    // Undefined fields are dropped by the spread, so an update touches
    // only what was actually sent.
    await prisma.matchPlayerInnings.upsert({
      where: { matchPlayerId_inningsNumber: { matchPlayerId, inningsNumber } },
      create: { matchPlayerId, inningsNumber, ...stats },
      update: stats,
    });
  }

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
