import { Request, Response } from "express";
import prisma from "../config/prisma";
import { bulkPlayerImportSchema, createCatalogPlayerSchema, updateCatalogPlayerSchema } from "../utils/validators";

// ---------- Public: catalog listing ----------

// GET /api/team-catalog/:teamId/players — every player belonging to a team
export async function listPlayersByTeam(req: Request, res: Response) {
  const { teamId } = req.params as { teamId: string };

  const players = await prisma.player.findMany({
    where: { teamId },
    orderBy: { name: "asc" },
  });

  return res.status(200).json({ players });
}

// ---------- Admin: catalog CRUD ----------

// POST /api/players  (admin only) — create a reusable player in a team's catalog
export async function createPlayer(req: Request, res: Response) {
  const parsed = createCatalogPlayerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const data = parsed.data;

  const team = await prisma.team.findUnique({ where: { id: data.teamId } });
  if (!team) {
    return res.status(404).json({ error: "Team not found" });
  }

  const hasPhoto = data.hasPhoto ?? false;

  const player = await prisma.player.create({
    data: {
      name: data.name,
      teamId: data.teamId,
      role: data.role,
      creditValue: data.creditValue ?? 8.0,
      hasPhoto,
      // Lock rule: no photo toggle => force empty string regardless of what was sent
      imageUrl: hasPhoto ? data.imageUrl ?? "" : "",
    },
  });

  return res.status(201).json({ player });
}

// PATCH /api/players/:id  (admin only) — edit catalog details (name, role, credit, photo)
export async function updatePlayer(req: Request, res: Response) {
  const { id } = req.params as { id: string };

  const parsed = updateCatalogPlayerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const existing = await prisma.player.findUnique({ where: { id } });
  if (!existing) {
    return res.status(404).json({ error: "Player not found" });
  }

  const data = parsed.data;
  const hasPhoto = data.hasPhoto ?? existing.hasPhoto;

  const player = await prisma.player.update({
    where: { id },
    data: {
      ...data,
      hasPhoto,
      imageUrl: hasPhoto ? data.imageUrl ?? existing.imageUrl : "",
    },
  });

  return res.status(200).json({ player });
}

// DELETE /api/players/:id  (admin only)
export async function deletePlayer(req: Request, res: Response) {
  const { id } = req.params as { id: string };

  const existing = await prisma.player.findUnique({ where: { id } });
  if (!existing) {
    return res.status(404).json({ error: "Player not found" });
  }

  try {
    await prisma.player.delete({ where: { id } });
  } catch (err: any) {
    if (err.code === "P2003") {
      return res.status(409).json({ error: "Cannot delete a player already added to a match" });
    }
    throw err;
  }

  return res.status(200).json({ message: "Player deleted" });
}

/**
 * POST /api/players/bulk  (admin only)
 *
 * Adds many players to one team at once, from a CSV.
 *
 * Rows are checked against the team's sport before anything is written:
 * a cricket team given football roles would otherwise import fine and
 * then break team building, where the selection rules expect
 * WK/BAT/AR/BOWL.
 */
export async function bulkCreatePlayers(req: Request, res: Response) {
  const parsed = bulkPlayerImportSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const { teamId, rows, skipDuplicates = true } = parsed.data;

  const team = await prisma.team.findUnique({ where: { id: teamId } });
  if (!team) return res.status(404).json({ error: "Team not found" });

  const allowedRoles =
    team.sport === "FOOTBALL" ? ["GK", "DEF", "MID", "FWD"] : ["WK", "BAT", "AR", "BOWL"];

  const existing = await prisma.player.findMany({
    where: { teamId },
    select: { name: true },
  });
  const taken = new Set(existing.map((row) => row.name.trim().toLowerCase()));

  const created: string[] = [];
  const skipped: { row: number; name: string; reason: string }[] = [];

  for (const [index, row] of rows.entries()) {
    // 1 is the header line, so the first data row is 2 — which is what
    // the admin sees in their spreadsheet.
    const lineNumber = index + 2;
    const name = row.name.trim();
    const role = row.role.trim().toUpperCase();

    if (!allowedRoles.includes(role)) {
      skipped.push({
        row: lineNumber,
        name,
        reason: `Role "${row.role}" isn't one of ${allowedRoles.join(", ")}`,
      });
      continue;
    }

    if (taken.has(name.toLowerCase())) {
      if (skipDuplicates) {
        skipped.push({ row: lineNumber, name, reason: "Already in this team" });
        continue;
      }
    }

    const imageUrl = row.imageUrl?.trim() ?? "";

    await prisma.player.create({
      data: {
        teamId,
        name,
        role,
        creditValue: row.creditValue,
        hasPhoto: !!imageUrl,
        imageUrl,
      },
    });

    created.push(name);
    // Guards against the same name appearing twice inside one file.
    taken.add(name.toLowerCase());
  }

  return res.status(201).json({ created: created.length, names: created, skipped });
}
