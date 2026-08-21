import { Request, Response } from "express";
import prisma from "../config/prisma";
import { NotificationType } from "../generated/prisma/client";
import { coinAdjustmentSchema, banUserSchema, updateSettingsSchema } from "../utils/validators";
import { adminGiveBonus, adminGiveFine } from "../services/walletService";
import { getLiveCount, getLiveSessions, getVisitorHistory, LIVE_WINDOW_MS } from "../services/presenceService";
import { compareVersions } from "./appConfigController";

// GET /api/admin/coin-adjustments  (admin only)
// Audit log of every ADMIN_BONUS / ADMIN_FINE ever given, across all users.
export async function listCoinAdjustments(req: Request, res: Response) {
  const adjustments = await prisma.coinTransaction.findMany({
    where: { type: { in: ["ADMIN_BONUS", "ADMIN_FINE"] } },
    include: { user: { select: { id: true, name: true, username: true } } },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  return res.status(200).json({
    adjustments: adjustments.map((a) => ({
      id: a.id,
      userId: a.user.id,
      userName: a.user.name,
      username: a.user.username,
      type: a.type,
      amount: a.amount,
      reason: a.reason,
      createdAt: a.createdAt,
    })),
  });
}

// GET /api/admin/users  (admin only)
export async function listUsers(req: Request, res: Response) {
  const users = await prisma.user.findMany({
    select: {
      id: true,
      name: true,
      username: true,
      email: true,
      phone: true,
      avatarUrl: true,
      // Admin-only fields — the app collects these but never shows them.
      dateOfBirth: true,
      nidNumber: true,
      usernameChangedAt: true,
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
    username: u.username,
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

// GET /api/admin/users/:id  (admin only) — full detail for one user
export async function getUserDetail(req: Request, res: Response) {
  const { id: userId } = req.params as { id: string };

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      username: true,
      email: true,
      phone: true,
      coins: true,
      isAdmin: true,
      isBanned: true,
      bannedReason: true,
      bannedAt: true,
      createdAt: true,
    },
  });
  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }

  const [entries, transactions] = await Promise.all([
    prisma.contestEntry.findMany({
      where: { userId },
      include: {
        contest: { select: { id: true, name: true, matchId: true } },
        userTeam: { select: { teamName: true, totalPoints: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.coinTransaction.findMany({ where: { userId } }),
  ]);

  const distinctMatches = new Set(entries.map((e) => e.contest.matchId));
  const totalCoinsWon = transactions.filter((t) => t.type === "CONTEST_PRIZE").reduce((s, t) => s + t.amount, 0);
  const totalBonusGiven = transactions.filter((t) => t.type === "ADMIN_BONUS").reduce((s, t) => s + t.amount, 0);
  const totalFineGiven = transactions.filter((t) => t.type === "ADMIN_FINE").reduce((s, t) => s + Math.abs(t.amount), 0);

  return res.status(200).json({
    user,
    stats: {
      totalMatchesPlayed: distinctMatches.size,
      totalContestsJoined: entries.length,
      totalCoinsWon,
      totalBonusGiven,
      totalFineGiven,
    },
    participations: entries.map((e) => ({
      contestId: e.contest.id,
      contestName: e.contest.name,
      matchId: e.contest.matchId,
      teamName: e.userTeam.teamName,
      points: e.userTeam.totalPoints,
      rank: e.rank,
      joinedAt: e.createdAt,
    })),
  });
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

  // Guard the pairing that would lock every user out: a minimum higher
  // than the latest release means nobody can ever satisfy it.
  const current = await prisma.appSettings.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
  const latest = parsed.data.latestAppVersion ?? current.latestAppVersion;
  const minimum = parsed.data.minSupportedVersion ?? current.minSupportedVersion;

  if (compareVersions(minimum, latest) > 0) {
    return res.status(400).json({
      error: "Minimum supported version can't be newer than the latest released version",
    });
  }

  const settings = await prisma.appSettings.update({
    where: { id: 1 },
    data: parsed.data,
  });

  return res.status(200).json({ settings });
}

// GET /api/admin/analytics/visitors?hours=24  (admin only)
// Powers the live-traffic screen: who's online right now, plus an hourly
// series for the graph.
export async function getVisitorAnalytics(req: Request, res: Response) {
  const hours = Math.min(Math.max(parseInt(String(req.query.hours ?? "24"), 10) || 24, 1), 24 * 14);

  const [liveCount, sessions, history] = await Promise.all([
    getLiveCount(),
    getLiveSessions(),
    getVisitorHistory(hours),
  ]);

  return res.status(200).json({
    liveCount,
    liveWindowSeconds: LIVE_WINDOW_MS / 1000,
    sessions: sessions.map((session) => ({
      id: session.id,
      deviceId: session.deviceId,
      platform: session.platform,
      appVersion: session.appVersion,
      lastSeenAt: session.lastSeenAt,
      userId: session.user?.id ?? null,
      userName: session.user?.name ?? null,
      username: session.user?.username ?? null,
    })),
    history,
  });
}
