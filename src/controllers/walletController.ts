import { Request, Response } from "express";
import prisma from "../config/prisma";
import { claimDailyBonus, DailyBonusAlreadyClaimedError } from "../services/walletService";

// GET /api/wallet/me  (auth required)
export async function getWallet(req: Request, res: Response) {
  const userId = req.userId as string;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { coins: true, lastDailyBonusAt: true },
  });

  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }

  const now = new Date();
  const claimedToday =
    !!user.lastDailyBonusAt &&
    user.lastDailyBonusAt.getUTCFullYear() === now.getUTCFullYear() &&
    user.lastDailyBonusAt.getUTCMonth() === now.getUTCMonth() &&
    user.lastDailyBonusAt.getUTCDate() === now.getUTCDate();

  return res.status(200).json({ coins: user.coins, dailyBonusClaimedToday: claimedToday });
}

// POST /api/wallet/claim-daily-bonus  (auth required)
export async function postClaimDailyBonus(req: Request, res: Response) {
  const userId = req.userId as string;

  try {
    const result = await claimDailyBonus(userId);
    return res.status(200).json({ message: "Daily bonus claimed", ...result });
  } catch (err) {
    if (err instanceof DailyBonusAlreadyClaimedError) {
      return res.status(409).json({ error: err.message });
    }
    throw err;
  }
}

// GET /api/wallet/transactions  (auth required) — the user's own coin ledger
export async function getTransactions(req: Request, res: Response) {
  const userId = req.userId as string;

  const transactions = await prisma.coinTransaction.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return res.status(200).json({ transactions });
}
