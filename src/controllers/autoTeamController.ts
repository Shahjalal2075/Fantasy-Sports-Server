import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import prisma from "../config/prisma";
import { generateTeams, PoolPlayer } from "../utils/autoTeamGenerator";
import { debitCoins, InsufficientCoinsError } from "../services/walletService";
import { sendPush } from "../services/pushService";
import { CoinTransactionType } from "../generated/prisma/client";

/**
 * Building teams for users automatically.
 *
 * This tool spends other people's coins and enters them into contests,
 * so it sits behind its own PIN rather than ordinary admin access, and
 * every affected user is notified.
 */

const PIN = process.env.ADMIN_TOOL_PIN || "52542";
const TOOL_SCOPE = "auto-teams";
/** Long enough for one sitting, short enough that a left-open tab expires. */
const TOKEN_TTL = "2h";

// ---------- PIN gate ----------

// POST /api/admin/auto-teams/unlock   body: { pin }
export function unlock(req: Request, res: Response) {
  const pin = String(req.body?.pin ?? "");

  // Compared here rather than in the panel: a PIN checked in the browser
  // is visible to anyone who opens the bundle.
  if (pin !== PIN) {
    return res.status(401).json({ error: "Wrong PIN" });
  }

  const token = jwt.sign({ scope: TOOL_SCOPE }, process.env.JWT_SECRET as string, {
    expiresIn: TOKEN_TTL,
  });

  return res.status(200).json({ token });
}

export function requireToolPin(req: Request, res: Response, next: NextFunction) {
  const token = String(req.header("x-tool-token") ?? "");
  if (!token) return res.status(401).json({ error: "Locked" });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET as string) as { scope?: string };
    if (payload.scope !== TOOL_SCOPE) return res.status(401).json({ error: "Locked" });
    return next();
  } catch {
    return res.status(401).json({ error: "Session expired — enter the PIN again" });
  }
}

// ---------- Data the tool needs ----------

// GET /api/admin/auto-teams/matches
export async function upcomingMatches(_req: Request, res: Response) {
  const matches = await prisma.match.findMany({
    where: { status: "UPCOMING" },
    orderBy: { startTime: "asc" },
    include: { teamA: true, teamB: true, _count: { select: { contests: true } } },
  });

  return res.status(200).json({ matches });
}

// GET /api/admin/auto-teams/matches/:matchId/players
export async function matchPool(req: Request, res: Response) {
  const { matchId } = req.params as { matchId: string };

  const match = await prisma.match.findUnique({
    where: { id: matchId },
    include: { teamA: true, teamB: true },
  });
  if (!match) return res.status(404).json({ error: "Match not found" });

  const players = await prisma.matchPlayer.findMany({
    where: { matchId },
    include: { player: { include: { team: true } } },
    orderBy: { player: { name: "asc" } },
  });

  return res.status(200).json({
    match,
    players: players.map((mp) => ({
      matchPlayerId: mp.id,
      name: mp.player.name,
      role: mp.player.role,
      creditValue: mp.player.creditValue,
      imageUrl: mp.player.imageUrl,
      isPlaying: mp.isPlaying,
      teamId: mp.player.teamId,
      teamShortName: mp.player.team.shortName,
    })),
  });
}

// GET /api/admin/auto-teams/users?q=
export async function searchUsers(req: Request, res: Response) {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";

  const users = await prisma.user.findMany({
    where: {
      isBanned: false,
      isAdmin: false,
      ...(q.length >= 2
        ? {
            OR: [
              { name: { contains: q, mode: "insensitive" as const } },
              { username: { contains: q, mode: "insensitive" as const } },
              { phone: { contains: q } },
            ],
          }
        : {}),
    },
    select: { id: true, name: true, username: true, coins: true },
    orderBy: { createdAt: "desc" },
    take: q.length >= 2 ? 30 : 50,
  });

  return res.status(200).json({ users });
}

// ---------- Generate ----------

const generateSchema = z.object({
  matchId: z.string().uuid(),
  userIds: z.array(z.string().uuid()).min(1, "Choose at least one user").max(500),
  pool: z
    .array(
      z.object({
        matchPlayerId: z.string().uuid(),
        priority: z.number().int().min(0).max(10).optional(),
      })
    )
    .min(11, "The pool needs at least 11 players"),
  captainIds: z.array(z.string().uuid()).min(1, "Choose at least one captain"),
  viceCaptainIds: z.array(z.string().uuid()).min(1, "Choose at least one vice-captain"),
});

/**
 * POST /api/admin/auto-teams/generate
 *
 * One team per user, each obeying the rules a player faces by hand.
 *
 * Running it again replaces the team it made last time rather than
 * adding a second one. Adjusting the pool and regenerating is the normal
 * way to use this, and a fresh team each run would leave the earlier
 * ones behind — already entered in contests, and no longer what the
 * admin intended.
 */
export async function generate(req: Request, res: Response) {
  const parsed = generateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const { matchId, userIds, pool, captainIds, viceCaptainIds } = parsed.data;

  const match = await prisma.match.findUnique({ where: { id: matchId } });
  if (!match) return res.status(404).json({ error: "Match not found" });
  if (match.status !== "UPCOMING") {
    return res.status(400).json({ error: "This match has already started." });
  }

  const matchPlayers = await prisma.matchPlayer.findMany({
    where: { matchId, id: { in: pool.map((row) => row.matchPlayerId) } },
    include: { player: true },
  });

  const priorityOf = new Map(pool.map((row) => [row.matchPlayerId, row.priority ?? 0]));

  const poolPlayers: PoolPlayer[] = matchPlayers.map((mp) => ({
    matchPlayerId: mp.id,
    playerId: mp.playerId,
    name: mp.player.name,
    role: mp.player.role,
    creditValue: mp.player.creditValue,
    teamId: mp.player.teamId,
    priority: priorityOf.get(mp.id) ?? 0,
  }));

  // The team this tool made for each user last time, if any.
  const existing = await prisma.userTeam.findMany({
    where: { matchId, userId: { in: userIds } },
    orderBy: { createdAt: "asc" },
  });

  const existingFor = new Map<string, (typeof existing)[number]>();
  for (const team of existing) {
    // Keep the earliest: that's the one this tool created, and the one
    // any contest entry already points at.
    if (!existingFor.has(team.userId)) existingFor.set(team.userId, team);
  }

  const result = generateTeams({
    pool: poolPlayers,
    count: userIds.length,
    sport: match.sport,
    captainPool: captainIds,
    viceCaptainPool: viceCaptainIds,
  });

  const created: { userId: string; userTeamId: string }[] = [];
  let replaced = 0;

  for (const [index, team] of result.teams.entries()) {
    const userId = userIds[index];
    const previous = existingFor.get(userId);

    if (previous) {
      // Rewritten in place, so any contest entry pointing at this team
      // keeps working and simply reflects the new selection.
      await prisma.$transaction([
        prisma.userTeamPlayer.deleteMany({ where: { userTeamId: previous.id } }),
        prisma.userTeam.update({
          where: { id: previous.id },
          data: {
            captainId: team.captainId,
            viceCaptainId: team.viceCaptainId,
            players: {
              create: team.matchPlayerIds.map((matchPlayerId) => ({ matchPlayerId })),
            },
          },
        }),
      ]);

      created.push({ userId, userTeamId: previous.id });
      replaced += 1;
      continue;
    }

    const userTeam = await prisma.userTeam.create({
      data: {
        userId,
        matchId,
        teamName: `Team ${index + 1}`,
        captainId: team.captainId,
        viceCaptainId: team.viceCaptainId,
        players: {
          create: team.matchPlayerIds.map((matchPlayerId) => ({ matchPlayerId })),
        },
      },
    });

    created.push({ userId, userTeamId: userTeam.id });
  }

  return res.status(201).json({
    created: created.length,
    // Split out so the admin can see this was a rerun rather than a
    // first pass.
    replaced,
    teams: created,
    failed: result.failed,
  });
}

// ---------- Join a contest ----------

const joinSchema = z.object({
  contestId: z.string().uuid(),
  userIds: z.array(z.string().uuid()).min(1).max(500),
});

/**
 * POST /api/admin/auto-teams/join
 *
 * Enters each user's generated team into a contest.
 *
 * Paid contests debit the user's own balance, and everyone affected is
 * notified — they are being entered into something they didn't ask for,
 * and finding coins missing with no explanation would be worse.
 */
export async function joinContest(req: Request, res: Response) {
  const parsed = joinSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const { contestId, userIds } = parsed.data;

  const contest = await prisma.contest.findUnique({
    where: { id: contestId },
    include: { match: true, _count: { select: { entries: true } } },
  });
  if (!contest) return res.status(404).json({ error: "Contest not found" });
  if (contest.isCancelled) return res.status(400).json({ error: "This contest was cancelled." });

  const joined: string[] = [];
  const skipped: { userId: string; reason: string }[] = [];

  let seatsLeft = contest.maxEntries - contest._count.entries;

  for (const userId of userIds) {
    if (seatsLeft <= 0) {
      skipped.push({ userId, reason: "Contest full" });
      continue;
    }

    const team = await prisma.userTeam.findFirst({
      where: { userId, matchId: contest.matchId },
      orderBy: { createdAt: "desc" },
    });

    if (!team) {
      skipped.push({ userId, reason: "No team for this match" });
      continue;
    }

    const already = await prisma.contestEntry.findFirst({
      where: { contestId, userId },
      select: { id: true },
    });
    if (already) {
      skipped.push({ userId, reason: "Already joined" });
      continue;
    }

    try {
      await prisma.$transaction(async (tx) => {
        if (contest.entryCost > 0) {
          await debitCoins(tx, userId, contest.entryCost, CoinTransactionType.CONTEST_ENTRY, {
            contestId,
            reason: `Entry — ${contest.name}`,
          });
        }

        await tx.contestEntry.create({
          data: { contestId, userId, userTeamId: team.id },
        });
      });

      joined.push(userId);
      seatsLeft -= 1;
    } catch (error) {
      skipped.push({
        userId,
        reason:
          error instanceof InsufficientCoinsError
            ? "Not enough coins"
            : (error as Error).message.slice(0, 80),
      });
    }
  }

  // Told after the fact, but told. Coins leaving an account with nothing
  // to explain it is the part that would feel wrong.
  if (joined.length > 0) {
    await prisma.notification.createMany({
      data: joined.map((userId) => ({
        userId,
        type: "GENERIC" as const,
        title: `You've been entered into ${contest.name}`,
        message:
          contest.entryCost > 0
            ? `A team was created for you and ${contest.entryCost.toLocaleString()} coins were used for the entry.`
            : "A team was created for you and entered into this free contest.",
      })),
    });

    await sendPush({
      event: "CUSTOM",
      title: `You're in ${contest.name}`,
      body:
        contest.entryCost > 0
          ? `A team was created for you. Entry cost ${contest.entryCost.toLocaleString()} coins.`
          : "A team was created for you and entered into this free contest.",
      url: `match:${contest.matchId}`,
      userIds: joined,
      force: true,
    });
  }

  return res.status(200).json({ joined: joined.length, skipped });
}
