import prisma from "../config/prisma";

/**
 * Per-user totals for the admin users list.
 *
 * All four are computed with one grouped query each rather than a lookup
 * per user — the list loads every account at once, and a per-row query
 * would turn a single page load into hundreds of round trips.
 */

export interface UserTotals {
  /**
   * Coins granted by a person, less coins taken away.
   *
   * Deliberately narrow: admin bonuses and approved coin requests count,
   * fines subtract. Daily bonuses, promo codes and referral rewards do
   * not — those are automatic, and mixing them in would hide how much an
   * account has actually been given by hand.
   */
  totalBonus: number;
  /** Coins redeemed through approved gift requests. */
  totalWithdraw: number;
  /** Entry fees tied up in contests whose match hasn't finished. */
  ongoing: number;
  /**
   * Net of what's awaiting a decision: coin requests in, gift requests
   * out. Positive means more is coming in than going out.
   */
  pendingNet: number;
  pendingIn: number;
  pendingOut: number;
}

export async function loadUserTotals(): Promise<Map<string, UserTotals>> {
  const [bonusRows, giftRows, ongoingRows, pendingCoinRows, pendingGiftRows] = await Promise.all([
    // Hand-granted coins, by type so fines can be subtracted.
    prisma.coinTransaction.groupBy({
      by: ["userId", "type"],
      where: { type: { in: ["ADMIN_BONUS", "ADMIN_FINE", "COIN_REQUEST"] } },
      _sum: { amount: true },
    }),

    prisma.giftRequest.groupBy({
      by: ["userId"],
      where: { status: "APPROVED" },
      _sum: { coinAmount: true },
    }),

    // Entry fees locked in contests still to be settled. Cancelled
    // contests are excluded: those coins have already been refunded.
    prisma.$queryRaw<{ userId: string; total: bigint | number }[]>`
      SELECT e."userId", COALESCE(SUM(c."entryCost"), 0) AS total
      FROM "contest_entries" e
      JOIN "contests" c ON c."id" = e."contestId"
      JOIN "matches" m ON m."id" = c."matchId"
      WHERE c."isCancelled" = false
        AND m."status" <> 'COMPLETED'
        AND m."status" <> 'CANCELLED'
      GROUP BY e."userId"
    `,

    prisma.coinRequest.groupBy({
      by: ["userId"],
      where: { status: { in: ["PENDING", "HELD"] } },
      _sum: { totalAmount: true },
    }),

    prisma.giftRequest.groupBy({
      by: ["userId"],
      where: { status: "PENDING" },
      _sum: { coinAmount: true },
    }),
  ]);

  const totals = new Map<string, UserTotals>();

  const forUser = (userId: string): UserTotals => {
    let entry = totals.get(userId);
    if (!entry) {
      entry = {
        totalBonus: 0,
        totalWithdraw: 0,
        ongoing: 0,
        pendingNet: 0,
        pendingIn: 0,
        pendingOut: 0,
      };
      totals.set(userId, entry);
    }
    return entry;
  };

  for (const row of bonusRows) {
    const amount = row._sum.amount ?? 0;
    // Fines are stored as positive amounts with a debit type, so they
    // have to be subtracted explicitly rather than summed blindly.
    forUser(row.userId).totalBonus += row.type === "ADMIN_FINE" ? -amount : amount;
  }

  for (const row of giftRows) {
    forUser(row.userId).totalWithdraw += row._sum.coinAmount ?? 0;
  }

  for (const row of ongoingRows) {
    forUser(row.userId).ongoing += Number(row.total);
  }

  for (const row of pendingCoinRows) {
    forUser(row.userId).pendingIn += row._sum.totalAmount ?? 0;
  }

  for (const row of pendingGiftRows) {
    forUser(row.userId).pendingOut += row._sum.coinAmount ?? 0;
  }

  for (const entry of totals.values()) {
    entry.pendingNet = entry.pendingIn - entry.pendingOut;
  }

  return totals;
}

/** The same figures for one account, for the user detail page. */
export async function loadTotalsForUser(userId: string): Promise<UserTotals> {
  const all = await loadUserTotals();
  return (
    all.get(userId) ?? {
      totalBonus: 0,
      totalWithdraw: 0,
      ongoing: 0,
      pendingNet: 0,
      pendingIn: 0,
      pendingOut: 0,
    }
  );
}
