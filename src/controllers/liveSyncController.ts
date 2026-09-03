import { Request, Response } from "express";
import { z } from "zod";
import prisma from "../config/prisma";
import {
  applyLiveScore,
  connectAndReconcile,
  disconnectMatch,
  ensureMatchCode,
} from "../services/liveSyncService";
import { calculateMatchPlayerPoints, recalculateMatchPoints } from "../services/pointsService";
import { randomPlayerCode } from "../utils/liveCodes";

/**
 * Endpoints the separate live-score service talks to, plus the admin
 * screens that manage the pairing.
 *
 * The live service is a different application on a different host with
 * its own database. It authenticates with a shared key, never with an
 * admin login.
 */

// ---------- Called by the live service ----------

const connectSchema = z.object({
  code: z.string().min(4).max(12),
  liveMatchId: z.string().min(1),
  liveLabel: z.string().max(160).optional(),
  players: z
    .array(z.object({ name: z.string().min(1).max(120), code: z.string().max(12).optional() }))
    .max(200),
});

// POST /api/live-sync/connect
export async function liveConnect(req: Request, res: Response) {
  const parsed = connectSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const result = await connectAndReconcile(parsed.data);
  if ("error" in result) return res.status(404).json(result);

  return res.status(200).json(result);
}

const scoreSchema = z.object({
  code: z.string().min(4).max(12),
  innings: z
    .array(
      z.object({
        inningsNumber: z.number().int().min(1).max(4),
        teamName: z.string().min(1).max(120),
        runs: z.number().int().min(0).max(2000),
        wickets: z.number().int().min(0).max(10),
        overs: z.number().min(0).max(500),
      })
    )
    .max(4),
  players: z
    .array(
      z.object({
        code: z.string().min(1).max(12),
        inningsNumber: z.number().int().min(1).max(4),

        runs: z.number().int().min(0).max(1000).optional(),
        ballsFaced: z.number().int().min(0).max(1000).optional(),
        fours: z.number().int().min(0).max(200).optional(),
        sixes: z.number().int().min(0).max(200).optional(),
        isOut: z.boolean().optional(),

        ballsBowled: z.number().int().min(0).max(1000).optional(),
        maidens: z.number().int().min(0).max(100).optional(),
        runsConceded: z.number().int().min(0).max(1000).optional(),
        wickets: z.number().int().min(0).max(20).optional(),

        catches: z.number().int().min(0).max(50).optional(),
        stumpings: z.number().int().min(0).max(50).optional(),
        runOutsDirect: z.number().int().min(0).max(50).optional(),
        runOutsIndirect: z.number().int().min(0).max(50).optional(),
      })
    )
    .max(200),
});

/**
 * POST /api/live-sync/score
 *
 * Merges the pushed scorecard, then recalculates points in the same
 * request — an admin shouldn't have to remember a second step, and a
 * scoreboard that's been updated but not scored is worse than one that
 * hasn't been touched.
 */
export async function liveScore(req: Request, res: Response) {
  const parsed = scoreSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const result = await applyLiveScore(parsed.data);
  if ("error" in result) return res.status(400).json(result);

  let pointsError: string | null = null;
  try {
    await calculateMatchPlayerPoints(result.matchId);
    await recalculateMatchPoints(result.matchId);
    // Drives the "Last updated" line the app shows on a leaderboard.
    await prisma.match.update({
      where: { id: result.matchId },
      data: { pointsCalculatedAt: new Date() },
    });
  } catch (error) {
    // The stats landed; only the scoring failed. Say so plainly rather
    // than reporting the whole push as a failure.
    pointsError = error instanceof Error ? error.message : "Point calculation failed";
  }

  return res.status(200).json({ ...result, pointsCalculated: !pointsError, pointsError });
}

// ---------- Admin panel ----------

// POST /api/admin/matches/:id/live-link  — creates or returns the code
export async function createMatchLink(req: Request, res: Response) {
  const { id: matchId } = req.params as { id: string };

  const match = await prisma.match.findUnique({ where: { id: matchId }, select: { id: true } });
  if (!match) return res.status(404).json({ error: "Match not found" });

  const link = await ensureMatchCode(matchId);
  return res.status(200).json({ link });
}

// DELETE /api/admin/matches/:id/live-link  — unpairs, keeping player codes
export async function removeMatchLink(req: Request, res: Response) {
  const { id: matchId } = req.params as { id: string };

  const link = await prisma.matchLiveLink.findUnique({ where: { matchId } });
  if (!link) return res.status(404).json({ error: "This match isn't paired" });

  await disconnectMatch(matchId);
  return res.status(200).json({ message: "Disconnected" });
}

// GET /api/admin/matches/:id/live-link  — pairing plus per-player status
export async function getMatchLink(req: Request, res: Response) {
  const { id: matchId } = req.params as { id: string };

  const [link, matchPlayers] = await Promise.all([
    prisma.matchLiveLink.findUnique({ where: { matchId } }),
    prisma.matchPlayer.findMany({
      where: { matchId },
      include: { player: { select: { name: true, teamId: true } }, liveLink: true },
    }),
  ]);

  return res.status(200).json({
    link,
    connected: !!link?.liveMatchId,
    players: matchPlayers.map((mp) => ({
      matchPlayerId: mp.id,
      name: mp.player.name,
      code: mp.liveLink?.code ?? null,
      liveName: mp.liveLink?.liveName ?? null,
      // Paired AND still reported by the live side.
      isConnected: !!mp.liveLink?.isActive,
      matchedAutomatically: mp.liveLink?.matchedAutomatically ?? true,
    })),
  });
}

const setCodeSchema = z.object({ code: z.string().min(2).max(12) });

/**
 * PATCH /api/admin/match-players/:matchPlayerId/live-code
 *
 * Repoints a pairing by hand. This is how two players sharing a name get
 * untangled: whoever the automatic match got wrong, the admin gives the
 * right code to.
 */
export async function setPlayerLiveCode(req: Request, res: Response) {
  const { matchPlayerId } = req.params as { matchPlayerId: string };

  const parsed = setCodeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const code = parsed.data.code.trim().toUpperCase();

  const target = await prisma.matchPlayer.findUnique({
    where: { id: matchPlayerId },
    select: { id: true, matchId: true },
  });
  if (!target) return res.status(404).json({ error: "Player not found in this match" });

  // Codes identify a player within one match, so a duplicate would make
  // an incoming scorecard ambiguous.
  const clash = await prisma.playerLiveLink.findFirst({
    where: {
      code,
      matchPlayerId: { not: matchPlayerId },
      matchPlayer: { matchId: target.matchId },
    },
    include: { matchPlayer: { include: { player: { select: { name: true } } } } },
  });

  if (clash) {
    return res.status(409).json({
      error: `That code is already used by ${clash.matchPlayer.player.name} in this match.`,
    });
  }

  const link = await prisma.playerLiveLink.upsert({
    where: { matchPlayerId },
    create: { matchPlayerId, code, matchedAutomatically: false },
    update: { code, matchedAutomatically: false },
  });

  return res.status(200).json({ link });
}

// DELETE /api/admin/match-players/:matchPlayerId/live-code
export async function clearPlayerLiveCode(req: Request, res: Response) {
  const { matchPlayerId } = req.params as { matchPlayerId: string };

  await prisma.playerLiveLink.deleteMany({ where: { matchPlayerId } });
  return res.status(200).json({ message: "Pairing removed" });
}

// POST /api/admin/match-players/:matchPlayerId/live-code/generate
export async function generatePlayerLiveCode(req: Request, res: Response) {
  const { matchPlayerId } = req.params as { matchPlayerId: string };

  const target = await prisma.matchPlayer.findUnique({
    where: { id: matchPlayerId },
    select: { id: true, matchId: true },
  });
  if (!target) return res.status(404).json({ error: "Player not found in this match" });

  const taken = new Set(
    (
      await prisma.playerLiveLink.findMany({
        where: { matchPlayer: { matchId: target.matchId } },
        select: { code: true },
      })
    ).map((row) => row.code)
  );

  let code = randomPlayerCode();
  for (let attempt = 0; attempt < 50 && taken.has(code); attempt += 1) {
    code = randomPlayerCode();
  }

  const link = await prisma.playerLiveLink.upsert({
    where: { matchPlayerId },
    create: { matchPlayerId, code, matchedAutomatically: false },
    update: { code, matchedAutomatically: false },
  });

  return res.status(200).json({ link });
}
