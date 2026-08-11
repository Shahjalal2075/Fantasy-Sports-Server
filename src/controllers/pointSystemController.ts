import { Request, Response } from "express";
import prisma from "../config/prisma";
import { createPointSystemSchema, updatePointSystemSchema } from "../utils/validators";
import {
  DEFAULT_CRICKET_RULES_T20,
  DEFAULT_CRICKET_RULES_ODI,
  DEFAULT_CRICKET_RULES_TEST,
  DEFAULT_CRICKET_RULES_T10,
  DEFAULT_CRICKET_RULES_H100,
  DEFAULT_FOOTBALL_RULES,
} from "../utils/fantasyScoring";

// GET /api/point-systems?sport=CRICKET  (public — Match form uses this to
// show format options, and to display "what will this format score like")
export async function listPointSystems(req: Request, res: Response) {
  const { sport } = req.query;

  const pointSystems = await prisma.pointSystem.findMany({
    where: { sport: sport ? (sport as any) : undefined },
    orderBy: [{ sport: "asc" }, { format: "asc" }],
  });

  return res.status(200).json({ pointSystems });
}

// GET /api/point-systems/defaults  (public — the built-in starting values
// for each format, used by the admin panel's "New format" / "reset" buttons)
export async function getDefaultRules(_req: Request, res: Response) {
  return res.status(200).json({
    CRICKET: {
      T20: DEFAULT_CRICKET_RULES_T20,
      ODI: DEFAULT_CRICKET_RULES_ODI,
      Test: DEFAULT_CRICKET_RULES_TEST,
      T10: DEFAULT_CRICKET_RULES_T10,
      H100: DEFAULT_CRICKET_RULES_H100,
    },
    FOOTBALL: {
      Default: DEFAULT_FOOTBALL_RULES,
    },
  });
}

// POST /api/point-systems  (admin only)
export async function createPointSystem(req: Request, res: Response) {
  const parsed = createPointSystemSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const { sport, format, isDefault, rules } = parsed.data;

  // Only one default per sport
  if (isDefault) {
    await prisma.pointSystem.updateMany({ where: { sport, isDefault: true }, data: { isDefault: false } });
  }

  try {
    const pointSystem = await prisma.pointSystem.create({
      data: { sport, format, isDefault: isDefault ?? false, rules },
    });
    return res.status(201).json({ pointSystem });
  } catch (err: any) {
    if (err.code === "P2002") {
      return res.status(409).json({ error: `A point system for ${sport} / ${format} already exists` });
    }
    throw err;
  }
}

// PATCH /api/point-systems/:id  (admin only)
export async function updatePointSystem(req: Request, res: Response) {
  const { id } = req.params as { id: string };

  const parsed = updatePointSystemSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const existing = await prisma.pointSystem.findUnique({ where: { id } });
  if (!existing) {
    return res.status(404).json({ error: "Point system not found" });
  }

  const data = parsed.data;

  if (data.isDefault) {
    await prisma.pointSystem.updateMany({
      where: { sport: existing.sport, isDefault: true, id: { not: id } },
      data: { isDefault: false },
    });
  }

  const pointSystem = await prisma.pointSystem.update({ where: { id }, data });

  return res.status(200).json({ pointSystem });
}

// DELETE /api/point-systems/:id  (admin only)
export async function deletePointSystem(req: Request, res: Response) {
  const { id } = req.params as { id: string };

  const existing = await prisma.pointSystem.findUnique({ where: { id } });
  if (!existing) {
    return res.status(404).json({ error: "Point system not found" });
  }

  await prisma.pointSystem.delete({ where: { id } });

  return res.status(200).json({ message: "Point system deleted" });
}
