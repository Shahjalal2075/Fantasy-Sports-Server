import { Request, Response } from "express";
import prisma from "../config/prisma";
import { NotificationType } from "../generated/prisma/client";
import { coinAdjustmentSchema, banUserSchema, updateSettingsSchema } from "../utils/validators";
import { adminGiveBonus, adminGiveFine } from "../services/walletService";

// GET /api/admin/users  (admin only)
export async function listUsers(req: Request, res: Response) {
  const users = await prisma.user.findMany({
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      coins: true,
      isAdmin: true,
      isBanned: true,
      createdAt: true,
      _count: { select: { entries: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  const distinctMatchesPerUser = await prisma.$queryRaw<{ userId: string; count: bigint }[]>`
    SELECT "userId", COUNT(DISTINCT "matchId") as count
    FROM "user_teams"
    GROUP BY "userId"
  `;
  const matchCountMap = new Map(distinctMatchesPerUser.map((r) => [r.userId, Number(r.count)]));

  const result = users.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    phone: u.phone,
    coins: u.coins,
    isAdmin: u.isAdmin,
    isBanned: u.isBanned,
    createdAt: u.createdAt,
    totalMatchesPlayed: matchCountMap.get(u.id) ?? 0,
    totalContestsJoined: u._count.entries,
  }));

  return res.status(200).json({ users: result });
}

// POST /api/admin/users/:id/bonus  (admin only)  body: { amount, reason }
export async function giveBonus(req: Request, res: Response) {
  const { id: userId } = req.params as { id: string };

  const parsed = coinAdjustmentSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return res.status(404).json({ error: "User not found" });

  const newBalance = await adminGiveBonus(userId, parsed.data.amount, parsed.data.reason);
  return res.status(200).json({ message: "Bonus given", coins: newBalance });
}

// POST /api/admin/users/:id/fine  (admin only)  body: { amount, reason }
export async function giveFine(req: Request, res: Response) {
  const { id: userId } = req.params as { id: string };

  const parsed = coinAdjustmentSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return res.status(404).json({ error: "User not found" });

  const newBalance = await adminGiveFine(userId, parsed.data.amount, parsed.data.reason);
  return res.status(200).json({ message: "Fine applied", coins: newBalance });
}

// POST /api/admin/users/:id/ban  (admin only)  body: { reason? }
export async function banUser(req: Request, res: Response) {
  const { id: userId } = req.params as { id: string };

  const parsed = banUserSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return res.status(404).json({ error: "User not found" });
  if (user.isAdmin) return res.status(400).json({ error: "Cannot ban an admin account" });

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: { isBanned: true, bannedReason: parsed.data.reason, bannedAt: new Date() },
    });
    await tx.notification.create({
      data: {
        userId,
        type: NotificationType.BAN,
        title: "Your account has been banned",
        message: parsed.data.reason || "Contact support for more information.",
      },
    });
  });

  return res.status(200).json({ message: "User banned" });
}

// POST /api/admin/users/:id/unban  (admin only)
export async function unbanUser(req: Request, res: Response) {
  const { id: userId } = req.params as { id: string };

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return res.status(404).json({ error: "User not found" });

  await prisma.user.update({
    where: { id: userId },
    data: { isBanned: false, bannedReason: null, bannedAt: null },
  });

  return res.status(200).json({ message: "User unbanned" });
}

// GET /api/admin/settings  (admin only)
export async function getSettings(req: Request, res: Response) {
  const settings = await prisma.appSettings.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1 },
  });
  return res.status(200).json({ settings });
}

// PATCH /api/admin/settings  (admin only)  body: { dailyBonusAmount }
export async function updateSettings(req: Request, res: Response) {
  const parsed = updateSettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const settings = await prisma.appSettings.upsert({
    where: { id: 1 },
    update: parsed.data,
    create: { id: 1, ...parsed.data },
  });

  return res.status(200).json({ settings });
}
