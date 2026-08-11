import { Request, Response } from "express";
import prisma from "../config/prisma";
import { createTeamEntitySchema, updateTeamEntitySchema } from "../utils/validators";

// GET /api/teams-list?sport=CRICKET  (public — used to populate dropdowns)
export async function listTeamEntities(req: Request, res: Response) {
  const { sport } = req.query;

  const teams = await prisma.team.findMany({
    where: { sport: sport ? (sport as any) : undefined },
    orderBy: { name: "asc" },
  });

  return res.status(200).json({ teams });
}

// POST /api/teams-list  (admin only)
export async function createTeamEntity(req: Request, res: Response) {
  const parsed = createTeamEntitySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const { name, shortName, sport, hasLogo, logoUrl } = parsed.data;

  const team = await prisma.team.create({
    data: {
      name,
      shortName,
      sport,
      hasLogo: hasLogo ?? false,
      // Lock rule: no logo toggle => force empty string regardless of what was sent
      logoUrl: hasLogo ? logoUrl ?? "" : "",
    },
  });

  return res.status(201).json({ team });
}

// PATCH /api/teams-list/:id  (admin only)
export async function updateTeamEntity(req: Request, res: Response) {
  const { id } = req.params as { id: string };

  const parsed = updateTeamEntitySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const existing = await prisma.team.findUnique({ where: { id } });
  if (!existing) {
    return res.status(404).json({ error: "Team not found" });
  }

  const data = parsed.data;
  const hasLogo = data.hasLogo ?? existing.hasLogo;

  const team = await prisma.team.update({
    where: { id },
    data: {
      ...data,
      hasLogo,
      logoUrl: hasLogo ? data.logoUrl ?? existing.logoUrl : "",
    },
  });

  return res.status(200).json({ team });
}

// GET /api/team-catalog/:id/players — Team Detail Mode "Players" tab
export async function getTeamPlayers(req: Request, res: Response) {
  const { id } = req.params as { id: string };
  const players = await prisma.player.findMany({ where: { teamId: id }, orderBy: { name: "asc" } });
  return res.status(200).json({ players });
}

// GET /api/team-catalog/:id/recent-matches — Team Detail Mode "Recent Match" tab
export async function getTeamRecentMatches(req: Request, res: Response) {
  const { id } = req.params as { id: string };
  const matches = await prisma.match.findMany({
    where: { OR: [{ teamAId: id }, { teamBId: id }] },
    include: { teamA: true, teamB: true },
    orderBy: { startTime: "desc" },
    take: 25,
  });
  return res.status(200).json({ matches });
}

// DELETE /api/teams-list/:id  (admin only)
export async function deleteTeamEntity(req: Request, res: Response) {
  const { id } = req.params as { id: string };

  const existing = await prisma.team.findUnique({ where: { id } });
  if (!existing) {
    return res.status(404).json({ error: "Team not found" });
  }

  try {
    await prisma.team.delete({ where: { id } });
  } catch (err: any) {
    // Foreign key constraint — team is referenced by a match or player
    if (err.code === "P2003") {
      return res.status(409).json({ error: "Cannot delete a team that's already used in a match" });
    }
    throw err;
  }

  return res.status(200).json({ message: "Team deleted" });
}
