import { Request, Response } from "express";
import { z } from "zod";
import prisma from "../config/prisma";

// Test matches run to four innings (each side bats twice); limited-overs
// formats use one each.
const MAX_INNINGS = 4;

const inningsSchema = z.object({
  inningsNumber: z.number().int().min(1).max(MAX_INNINGS),
  teamId: z.string().uuid("Pick which team batted"),
  runs: z.number().int().min(0).max(2000),
  wickets: z.number().int().min(0).max(10),
  // Overs as typed on the scoreboard: 19.4 means 19 overs and 4 balls,
  // so the fraction is sixths, not tenths.
  overs: z.number().min(0).max(500),
  isDeclared: z.boolean().optional(),
});

const saveSchema = z.object({
  innings: z.array(inningsSchema).max(MAX_INNINGS),
});

/** "19.4" -> 118 balls. Anything past .5 is treated as a full over. */
function oversToBalls(overs: number): number {
  const whole = Math.floor(overs);
  // toFixed avoids 19.4 - 19 landing on 0.39999999999999857.
  const fraction = Number((overs - whole).toFixed(2));
  const balls = Math.round(fraction * 10);
  return whole * 6 + Math.min(balls, 5);
}

/** 118 balls -> 19.4 */
export function ballsToOvers(balls: number): number {
  return Math.floor(balls / 6) + (balls % 6) / 10;
}

// GET /api/matches/:matchId/innings   (public — the app shows this)
export async function listInnings(req: Request, res: Response) {
  const { matchId } = req.params as { matchId: string };

  const innings = await prisma.matchInnings.findMany({
    where: { matchId },
    orderBy: { inningsNumber: "asc" },
    include: { team: { select: { id: true, name: true, shortName: true } } },
  });

  return res.status(200).json({
    innings: innings.map((row) => ({
      id: row.id,
      inningsNumber: row.inningsNumber,
      teamId: row.teamId,
      teamName: row.team.name,
      teamShortName: row.team.shortName,
      runs: row.runs,
      wickets: row.wickets,
      balls: row.balls,
      overs: ballsToOvers(row.balls),
      isDeclared: row.isDeclared,
    })),
  });
}

// PUT /api/matches/:matchId/innings   (admin only)
//
// Replaces the whole set rather than patching one at a time: the admin
// edits the scoreboard as a unit, and this keeps innings numbering
// consistent (no gaps, no orphans from a deleted row).
export async function saveInnings(req: Request, res: Response) {
  const { matchId } = req.params as { matchId: string };

  const parsed = saveSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const match = await prisma.match.findUnique({ where: { id: matchId } });
  if (!match) {
    return res.status(404).json({ error: "Match not found" });
  }

  const validTeamIds = new Set([match.teamAId, match.teamBId]);
  const seenInnings = new Set<number>();

  for (const entry of parsed.data.innings) {
    if (!validTeamIds.has(entry.teamId)) {
      return res.status(400).json({ error: "Each innings must belong to one of the two teams" });
    }
    if (seenInnings.has(entry.inningsNumber)) {
      return res.status(400).json({ error: "Two entries share the same innings number" });
    }
    seenInnings.add(entry.inningsNumber);
  }

  await prisma.$transaction(async (tx) => {
    // Wipe and rewrite — the payload is the complete scoreboard.
    await tx.matchInnings.deleteMany({ where: { matchId } });

    if (parsed.data.innings.length > 0) {
      await tx.matchInnings.createMany({
        data: parsed.data.innings.map((entry) => ({
          matchId,
          teamId: entry.teamId,
          inningsNumber: entry.inningsNumber,
          runs: entry.runs,
          wickets: entry.wickets,
          balls: oversToBalls(entry.overs),
          isDeclared: entry.isDeclared ?? false,
        })),
      });
    }
  });

  return listInnings(req, res);
}
