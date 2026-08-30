import { Request, Response } from "express";
import { CoinTransactionType } from "../generated/prisma/client";
import prisma from "../config/prisma";
import { payInviterIfDue } from "../services/referralService";
import { splitPrizes } from "../utils/prizeSplitting";
import { createContestSchema, joinContestSchema } from "../utils/validators";
import { debitCoins, creditCoins, InsufficientCoinsError } from "../services/walletService";

// ---------- Admin ----------

// POST /api/contests  (admin only)
export async function createContest(req: Request, res: Response) {
  const parsed = createContestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const { matchId, name, maxEntries, entryCost, prizeDistribution } = parsed.data;

  const match = await prisma.match.findUnique({ where: { id: matchId } });
  if (!match) {
    return res.status(404).json({ error: "Match not found" });
  }

  const contest = await prisma.contest.create({
    data: {
      matchId,
      name,
      maxEntries: maxEntries ?? 10000,
      entryCost: entryCost ?? 0,
      prizeDistribution: prizeDistribution ?? [],
    },
  });

  return res.status(201).json({ contest });
}

// ---------- Public ----------

// GET /api/contests?matchId=&hideFull=true  — list contests, with a live
// entry count. Pass hideFull=true (used by the mobile app) to exclude
// contests that are already at maxEntries — the admin panel omits this so
// admins can still see/manage full contests.
export async function listContests(req: Request, res: Response) {
  const { matchId, hideFull } = req.query;

  const contests = await prisma.contest.findMany({
    where: {
      matchId: matchId ? (matchId as string) : undefined,
      isCancelled: false,
    },
    include: { _count: { select: { entries: true } } },
    orderBy: { createdAt: "asc" },
  });

  const mapped = contests.map((c) => ({
    id: c.id,
    matchId: c.matchId,
    name: c.name,
    maxEntries: c.maxEntries,
    entryCost: c.entryCost,
    prizeDistribution: c.prizeDistribution,
    prizesDistributed: c.prizesDistributed,
    isCancelled: c.isCancelled,
    entryCount: c._count.entries,
    isFull: c._count.entries >= c.maxEntries,
    createdAt: c.createdAt,
  }));

  const result = hideFull === "true" ? mapped.filter((c) => !c.isFull) : mapped;

  return res.status(200).json({ contests: result });
}

// GET /api/contests/:id
export async function getContestById(req: Request, res: Response) {
  const { id } = req.params as { id: string };

  const contest = await prisma.contest.findUnique({
    where: { id },
    include: { match: true, _count: { select: { entries: true } } },
  });

  if (!contest) {
    return res.status(404).json({ error: "Contest not found" });
  }

  return res.status(200).json({
    contest: {
      id: contest.id,
      matchId: contest.matchId,
      name: contest.name,
      maxEntries: contest.maxEntries,
      entryCost: contest.entryCost,
      prizeDistribution: contest.prizeDistribution,
      prizesDistributed: contest.prizesDistributed,
      isCancelled: contest.isCancelled,
      entryCount: contest._count.entries,
      isFull: contest._count.entries >= contest.maxEntries,
      match: contest.match,
      createdAt: contest.createdAt,
    },
  });
}

// ---------- Auth required ----------

// POST /api/contests/:id/join  body: { userTeamId }
export async function joinContest(req: Request, res: Response) {
  const { id: contestId } = req.params as { id: string };
  const userId = req.userId as string;

  const parsed = joinContestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }
  const { userTeamId } = parsed.data;

  const contest = await prisma.contest.findUnique({
    where: { id: contestId },
    include: { match: true, _count: { select: { entries: true } } },
  });
  if (!contest || contest.isCancelled) {
    return res.status(404).json({ error: "Contest not found" });
  }

  // Entries close at the same time team selection locks
  if (new Date() >= contest.match.lockTime) {
    return res.status(400).json({ error: "This contest is locked — the match has already started" });
  }

  if (contest._count.entries >= contest.maxEntries) {
    return res.status(400).json({ error: "This contest is full" });
  }

  // A user may only enter a contest once, with any ONE of their teams —
  // check this before touching coins so a doomed request never debits.
  const existingEntry = await prisma.contestEntry.findUnique({
    where: { contestId_userId: { contestId, userId } },
  });
  if (existingEntry) {
    return res.status(409).json({ error: "You've already joined this contest" });
  }

  const userTeam = await prisma.userTeam.findUnique({ where: { id: userTeamId } });
  if (!userTeam) {
    return res.status(404).json({ error: "Team not found" });
  }
  if (userTeam.userId !== userId) {
    return res.status(403).json({ error: "This is not your team" });
  }
  if (userTeam.matchId !== contest.matchId) {
    return res.status(400).json({ error: "This team was not built for this contest's match" });
  }

  try {
    const entry = await prisma.$transaction(async (tx) => {
      // Deduct entry cost in coins (0 = free contest, no-op debit skipped)
      if (contest.entryCost > 0) {
        await debitCoins(tx, userId, contest.entryCost, CoinTransactionType.CONTEST_ENTRY, {
          contestId,
          reason: `Joined contest: ${contest.name}`,
        });
      }

      return tx.contestEntry.create({
        data: { contestId, userId, userTeamId },
        include: { userTeam: true },
      });
    });
    // Paid entry only, first time only — this is the second leg of the
    // referral reward. Deliberately outside the join transaction: if it
    // fails, the user's entry still stands.
    await payInviterIfDue(userId, contest.entryCost);

    return res.status(201).json({ entry });
  } catch (err: any) {
    if (err instanceof InsufficientCoinsError) {
      return res.status(402).json({ error: `Not enough coins — this contest costs ${contest.entryCost} coins to join` });
    }
    if (err.code === "P2002") {
      return res.status(409).json({ error: "You've already joined this contest" });
    }
    throw err;
  }
}

// GET /api/contests/:id/leaderboard  — ranked by each entry's team totalPoints
export async function getLeaderboard(req: Request, res: Response) {
  const { id: contestId } = req.params as { id: string };

  const contest = await prisma.contest.findUnique({ where: { id: contestId } });
  if (!contest) {
    return res.status(404).json({ error: "Contest not found" });
  }

  // Only entrants may see who else is in a contest and how they're
  // scoring. Enforced here rather than only in the app, since the
  // endpoint is otherwise trivially callable by hand.
  //
  // Admins are exempt — they need the leaderboard to check scoring and
  // distribute prizes.
  const viewer = await prisma.user.findUnique({
    where: { id: req.userId as string },
    select: { isAdmin: true },
  });

  if (!viewer?.isAdmin) {
    const ownEntry = await prisma.contestEntry.findFirst({
      where: { contestId, userId: req.userId as string },
      select: { id: true },
    });

    if (!ownEntry) {
      return res.status(403).json({
        error: "Join this contest to see its leaderboard.",
        requiresEntry: true,
      });
    }
  }

  const entries = await prisma.contestEntry.findMany({
    where: { contestId },
    include: {
      userTeam: { select: { id: true, teamName: true, totalPoints: true } },
      // isVerified drives the blue tick beside a name on the leaderboard.
      user: { select: { id: true, name: true, username: true, isVerified: true } },
    },
    orderBy: { userTeam: { totalPoints: "desc" } },
  });

  const leaderboard = entries.map((entry, index) => ({
    rank: index + 1,
    userId: entry.user.id,
    userName: entry.user.name,
    isVerified: entry.user.isVerified,
    teamName: entry.userTeam.teamName,
    userTeamId: entry.userTeam.id,
    points: entry.userTeam.totalPoints,
  }));

  return res.status(200).json({ contestId, leaderboard });
}

// GET /api/contests/my?matchId=  — logged-in user's own contest entries
export async function getMyEntries(req: Request, res: Response) {
  const userId = req.userId as string;
  const { matchId } = req.query;

  const entries = await prisma.contestEntry.findMany({
    where: {
      userId,
      contest: matchId ? { matchId: matchId as string } : undefined,
    },
    include: {
      contest: { include: { _count: { select: { entries: true } } } },
      userTeam: { select: { id: true, teamName: true, totalPoints: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  // Shape each nested contest like listContests does, so the app's
  // "My Contest" view can render the same card (spots filled, progress
  // bar) without a second round-trip per contest.
  const shaped = entries.map((entry) => {
    const { _count, ...contest } = entry.contest;
    return {
      ...entry,
      contest: {
        ...contest,
        entryCount: _count.entries,
        isFull: _count.entries >= contest.maxEntries,
      },
    };
  });

  return res.status(200).json({ entries: shaped });
}

// POST /api/contests/:id/cancel  (admin only)
// Only allowed while the contest is NOT full — once it's full, cancelling
// isn't offered (use distribute-prizes / let it run its course instead).
// Refunds every joined user's entry cost in coins, then marks the contest
// cancelled so it disappears from user-facing listings.
export async function cancelContest(req: Request, res: Response) {
  const { id: contestId } = req.params as { id: string };

  const contest = await prisma.contest.findUnique({
    where: { id: contestId },
    include: { _count: { select: { entries: true } } },
  });
  if (!contest) {
    return res.status(404).json({ error: "Contest not found" });
  }
  if (contest.isCancelled) {
    return res.status(409).json({ error: "This contest is already cancelled" });
  }
  if (contest._count.entries >= contest.maxEntries) {
    return res.status(400).json({ error: "A full contest can't be cancelled" });
  }

  const entries = await prisma.contestEntry.findMany({ where: { contestId } });

  const refunds: { userId: string; coins: number }[] = [];

  await prisma.$transaction(async (tx) => {
    if (contest.entryCost > 0) {
      for (const entry of entries) {
        await creditCoins(tx, entry.userId, contest.entryCost, CoinTransactionType.CONTEST_REFUND, {
          contestId,
          reason: `Contest cancelled: ${contest.name}`,
        });
        refunds.push({ userId: entry.userId, coins: contest.entryCost });
      }
    }
    await tx.contest.update({ where: { id: contestId }, data: { isCancelled: true } });
  });

  return res.status(200).json({ message: "Contest cancelled", refunds });
}
// Pays out coin prizes to the top-ranked entries according to the
// contest's prizeDistribution. Call this AFTER the match is complete and
// points have been calculated (via sync-live-score or calculate-points),
// so `rank` on each ContestEntry is final. Idempotent — refuses to run
// twice for the same contest via the prizesDistributed flag.
export async function distributePrizes(req: Request, res: Response) {
  const { id: contestId } = req.params as { id: string };

  const contest = await prisma.contest.findUnique({ where: { id: contestId } });
  if (!contest) {
    return res.status(404).json({ error: "Contest not found" });
  }
  if (contest.isCancelled) {
    return res.status(400).json({ error: "This contest was cancelled — no prizes to distribute" });
  }
  if (contest.prizesDistributed) {
    return res.status(409).json({ error: "Prizes for this contest have already been distributed" });
  }

  const prizeMap = new Map<number, number>(
    (contest.prizeDistribution as { rank: number; coins: number }[]).map((p) => [p.rank, p.coins])
  );

  if (prizeMap.size === 0) {
    return res.status(400).json({ error: "This contest has no prize distribution configured" });
  }

  // Every ranked entry, not just those on a paying rank: a group tied at
  // rank 3 in a top-3 contest still occupies places 3, 4 and 5, and the
  // splitter needs to see the whole group to divide correctly.
  const rankedEntries = await prisma.contestEntry.findMany({
    where: { contestId, rank: { not: null } },
    select: { id: true, userId: true, rank: true, createdAt: true },
    // Same order the leaderboard uses, so the odd coin from an uneven
    // split goes to the earliest joiner rather than at random.
    orderBy: [{ rank: "asc" }, { createdAt: "asc" }],
  });

  const splits = splitPrizes(
    rankedEntries.map((entry) => ({
      id: entry.id,
      userId: entry.userId,
      rank: entry.rank as number,
    })),
    prizeMap
  );

  const payouts: { userId: string; rank: number; coins: number; sharedBy: number }[] = [];

  await prisma.$transaction(async (tx) => {
    for (const split of splits) {
      await creditCoins(tx, split.userId, split.coins, CoinTransactionType.CONTEST_PRIZE, {
        contestId,
        reason:
          split.sharedBy > 1
            ? `Rank #${split.rank} prize (shared by ${split.sharedBy}) — ${contest.name}`
            : `Rank #${split.rank} prize — ${contest.name}`,
      });
      payouts.push({
        userId: split.userId,
        rank: split.rank,
        coins: split.coins,
        sharedBy: split.sharedBy,
      });
    }

    await tx.contest.update({ where: { id: contestId }, data: { prizesDistributed: true } });
  });

  return res.status(200).json({ message: "Prizes distributed", payouts });
}
