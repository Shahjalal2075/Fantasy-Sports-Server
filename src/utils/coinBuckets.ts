import { CoinTransactionType } from "../generated/prisma";

/**
 * Every coin sits in one of two buckets:
 *
 *   deposit      — daily bonus, promo codes, referrals, admin grants
 *   withdrawable — winnings from contests
 *
 * Both can be spent on contest entry, but only withdrawable coins can be
 * redeemed for a gift. That's the whole point of the split: coins a user
 * was given for free must not be convertible into a physical item.
 *
 * Kept as pure functions in their own file so the policy can be read —
 * and tested — without a database.
 */

export type Bucket = "deposit" | "withdrawable";

/** Which bucket a credit of this type lands in. */
export function creditBucket(type: CoinTransactionType): Bucket {
  switch (type) {
    // Winnings, and the return of coins that came out of winnings.
    case "CONTEST_PRIZE":
    case "GIFT_REFUND":
      return "withdrawable";
    // Everything else: bonuses, promo codes, referrals, and refunds of a
    // cancelled contest entry.
    default:
      return "deposit";
  }
}

export interface DebitPlan {
  fromDeposit: number;
  fromWithdrawable: number;
}

/**
 * How a debit is split across the buckets, or null when the balance
 * can't cover it.
 *
 * Gift requests may only draw on winnings. Everything else spends
 * deposit coins first and falls back to winnings, so a user's
 * withdrawable balance survives as long as possible.
 */
export function planDebit(
  type: CoinTransactionType,
  amount: number,
  deposit: number,
  withdrawable: number
): DebitPlan | null {
  if (amount <= 0) return { fromDeposit: 0, fromWithdrawable: 0 };

  if (type === "GIFT_REQUEST") {
    if (withdrawable < amount) return null;
    return { fromDeposit: 0, fromWithdrawable: amount };
  }

  if (deposit + withdrawable < amount) return null;

  const fromDeposit = Math.min(deposit, amount);
  return { fromDeposit, fromWithdrawable: amount - fromDeposit };
}
