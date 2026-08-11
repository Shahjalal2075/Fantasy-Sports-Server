import { Prisma, CoinTransactionType, NotificationType } from "../generated/prisma/client";
import prisma from "../config/prisma";

// Coins are a virtual, non-purchasable, non-withdrawable in-app currency.
// They are NEVER exchanged for real money in either direction. This file
// is the only place that mutates User.coins — everything goes through here
// so every movement is atomic and recorded in CoinTransaction.

export class InsufficientCoinsError extends Error {
  constructor() {
    super("Not enough coins");
  }
}

export class DailyBonusAlreadyClaimedError extends Error {
  constructor() {
    super("Today's daily bonus has already been claimed");
  }
}

function isSameUtcDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

async function getDailyBonusAmount(): Promise<number> {
  const settings = await prisma.appSettings.findUnique({ where: { id: 1 } });
  return settings?.dailyBonusAmount ?? 100;
}

// Credits the admin-configured daily bonus once per UTC calendar day per user.
export async function claimDailyBonus(userId: string): Promise<{ coins: number; amountCredited: number }> {
  const bonusAmount = await getDailyBonusAmount();

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user) throw new Error("User not found");

    const now = new Date();
    if (user.lastDailyBonusAt && isSameUtcDay(user.lastDailyBonusAt, now)) {
      throw new DailyBonusAlreadyClaimedError();
    }

    const updated = await tx.user.update({
      where: { id: userId },
      data: { coins: { increment: bonusAmount }, lastDailyBonusAt: now },
    });

    await tx.coinTransaction.create({
      data: {
        userId,
        type: CoinTransactionType.DAILY_BONUS,
        amount: bonusAmount,
        balanceAfter: updated.coins,
        reason: "Daily login bonus",
      },
    });

    return { coins: updated.coins, amountCredited: bonusAmount };
  });
}

// Debits `amount` coins from the user, inside the given transaction client.
// Uses a conditional update (WHERE coins >= amount) so concurrent debits
// can't push a balance negative — if the row wasn't matched, funds were
// insufficient at the moment of the update.
export async function debitCoins(
  tx: Prisma.TransactionClient,
  userId: string,
  amount: number,
  type: CoinTransactionType,
  opts?: { contestId?: string; reason?: string }
): Promise<number> {
  const result = await tx.user.updateMany({
    where: { id: userId, coins: { gte: amount } },
    data: { coins: { decrement: amount } },
  });

  if (result.count === 0) {
    throw new InsufficientCoinsError();
  }

  const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });

  await tx.coinTransaction.create({
    data: {
      userId,
      type,
      amount: -amount,
      balanceAfter: user.coins,
      contestId: opts?.contestId,
      reason: opts?.reason,
    },
  });

  return user.coins;
}

// Credits `amount` coins to the user, inside the given transaction client.
export async function creditCoins(
  tx: Prisma.TransactionClient,
  userId: string,
  amount: number,
  type: CoinTransactionType,
  opts?: { contestId?: string; reason?: string }
): Promise<number> {
  const user = await tx.user.update({
    where: { id: userId },
    data: { coins: { increment: amount } },
  });

  await tx.coinTransaction.create({
    data: {
      userId,
      type,
      amount,
      balanceAfter: user.coins,
      contestId: opts?.contestId,
      reason: opts?.reason,
    },
  });

  return user.coins;
}

// Admin gives a user bonus coins (custom amount + reason), and the user
// gets a Notification about it. Wrapped in one transaction.
export async function adminGiveBonus(userId: string, amount: number, reason: string) {
  return prisma.$transaction(async (tx) => {
    const balance = await creditCoins(tx, userId, amount, CoinTransactionType.ADMIN_BONUS, { reason });
    await tx.notification.create({
      data: {
        userId,
        type: NotificationType.COIN_BONUS,
        title: `You received ${amount} bonus coins`,
        message: reason,
        coinAmount: amount,
      },
    });
    return balance;
  });
}

// Admin fines a user (deducts coins, custom amount + reason). The fine is
// clamped to the user's current balance so it can never go negative — if
// they have fewer coins than the fine amount, they're taken to zero.
export async function adminGiveFine(userId: string, amount: number, reason: string) {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
    const actualAmount = Math.min(amount, user.coins);

    const updated = await tx.user.update({
      where: { id: userId },
      data: { coins: { decrement: actualAmount } },
    });

    await tx.coinTransaction.create({
      data: {
        userId,
        type: CoinTransactionType.ADMIN_FINE,
        amount: -actualAmount,
        balanceAfter: updated.coins,
        reason,
      },
    });

    await tx.notification.create({
      data: {
        userId,
        type: NotificationType.COIN_FINE,
        title: `You were fined ${actualAmount} coins`,
        message: reason,
        coinAmount: actualAmount,
      },
    });

    return updated.coins;
  });
}
