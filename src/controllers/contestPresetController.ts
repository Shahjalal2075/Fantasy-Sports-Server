import { Request, Response } from "express";
import { z } from "zod";
import prisma from "../config/prisma";
import { broadcast } from "../services/pushService";

/**
 * Saved contest shapes.
 *
 * A preset is a template, not a contest: applying one copies its values
 * into the form, and editing the preset afterwards leaves contests
 * already created from it alone.
 */

const prizeRowSchema = z.object({
  rank: z.number().int().min(1).max(10000),
  coins: z.number().int().min(0).max(10_000_000),
});

const presetSchema = z.object({
  name: z.string().min(1, "Give the preset a name").max(80),
  maxEntries: z.number().int().min(1).max(1_000_000),
  entryCost: z.number().int().min(0).max(1_000_000),
  prizeDistribution: z.array(prizeRowSchema).max(1000),
  description: z.string().max(200).optional(),
  sortOrder: z.number().int().min(0).max(999).optional(),
  isActive: z.boolean().optional(),
});

// GET /api/admin/contest-presets
export async function listPresets(_req: Request, res: Response) {
  const presets = await prisma.contestPreset.findMany({
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });

  return res.status(200).json({ presets });
}

// POST /api/admin/contest-presets
export async function createPreset(req: Request, res: Response) {
  const parsed = presetSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  // Prize ranks have to be unique, or two rows would claim the same
  // place and the payout split would be ambiguous.
  const ranks = parsed.data.prizeDistribution.map((row) => row.rank);
  if (new Set(ranks).size !== ranks.length) {
    return res.status(400).json({ error: "Two prize rows share the same rank." });
  }

  const last = await prisma.contestPreset.findFirst({ orderBy: { sortOrder: "desc" } });

  const preset = await prisma.contestPreset.create({
    data: {
      name: parsed.data.name.trim(),
      maxEntries: parsed.data.maxEntries,
      entryCost: parsed.data.entryCost,
      prizeDistribution: parsed.data.prizeDistribution,
      description: parsed.data.description?.trim() ?? "",
      sortOrder: parsed.data.sortOrder ?? (last ? last.sortOrder + 1 : 0),
      isActive: parsed.data.isActive ?? true,
    },
  });

  return res.status(201).json({ preset });
}

// PATCH /api/admin/contest-presets/:id
export async function updatePreset(req: Request, res: Response) {
  const { id } = req.params as { id: string };

  const parsed = presetSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const existing = await prisma.contestPreset.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: "Preset not found" });

  if (parsed.data.prizeDistribution) {
    const ranks = parsed.data.prizeDistribution.map((row) => row.rank);
    if (new Set(ranks).size !== ranks.length) {
      return res.status(400).json({ error: "Two prize rows share the same rank." });
    }
  }

  const preset = await prisma.contestPreset.update({
    where: { id },
    data: {
      ...parsed.data,
      ...(parsed.data.name ? { name: parsed.data.name.trim() } : {}),
    },
  });

  return res.status(200).json({ preset });
}

// DELETE /api/admin/contest-presets/:id
export async function deletePreset(req: Request, res: Response) {
  const { id } = req.params as { id: string };

  // Genuinely deleted: a preset is a template with nothing pointing at
  // it, so there's no history to protect.
  await prisma.contestPreset.deleteMany({ where: { id } });

  return res.status(200).json({ message: "Preset removed" });
}


const applySchema = z.object({
  matchId: z.string().uuid(),
  presetIds: z.array(z.string().uuid()).min(1, "Choose at least one preset").max(50),
});

/**
 * POST /api/admin/contest-presets/apply
 *
 * Creates a contest on a match from each chosen preset.
 *
 * Presets whose name already exists on that match are skipped rather
 * than duplicated — running this twice by accident shouldn't leave two
 * identical mega contests for people to split themselves across.
 */
export async function applyPresets(req: Request, res: Response) {
  const parsed = applySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const { matchId, presetIds } = parsed.data;

  const match = await prisma.match.findUnique({
    where: { id: matchId },
    include: { teamA: true, teamB: true },
  });
  if (!match) return res.status(404).json({ error: "Match not found" });

  const presets = await prisma.contestPreset.findMany({ where: { id: { in: presetIds } } });
  if (presets.length === 0) return res.status(400).json({ error: "No presets found" });

  const existing = await prisma.contest.findMany({
    where: { matchId },
    select: { name: true },
  });
  const taken = new Set(existing.map((row) => row.name.trim().toLowerCase()));

  const created: { id: string; name: string }[] = [];
  const skipped: string[] = [];

  for (const preset of presets) {
    if (taken.has(preset.name.trim().toLowerCase())) {
      skipped.push(preset.name);
      continue;
    }

    const contest = await prisma.contest.create({
      data: {
        matchId,
        name: preset.name,
        maxEntries: preset.maxEntries,
        entryCost: preset.entryCost,
        prizeDistribution: preset.prizeDistribution as never,
      },
    });

    created.push({ id: contest.id, name: contest.name });
    // Guards against two presets sharing a name in one request.
    taken.add(preset.name.trim().toLowerCase());
  }

  // One notification for the batch, not one per contest. Six pushes in a
  // row for the same match would read as a fault.
  if (created.length > 0) {
    await broadcast({
      event: "NEW_CONTEST",
      vars: {
        contest:
          created.length === 1
            ? created[0].name
            : `${created.length} new contests`,
        fixture: `${match.teamA?.shortName ?? "?"} vs ${match.teamB?.shortName ?? "?"}`,
        teamA: match.teamA?.name ?? "",
        teamB: match.teamB?.name ?? "",
        entryCost: 0,
      },
      url: `match:${matchId}`,
    });
  }

  return res.status(201).json({ created, skipped });
}
