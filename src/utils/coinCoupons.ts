import { CouponBonusType } from "../generated/prisma/client";

/**
 * Working out a coupon's bonus.
 *
 * Kept pure so the rule can be tested without a database, and so the
 * same function runs when a request is previewed and when it's approved
 * — the figure a user was shown must be the figure they get.
 */

export interface CouponLike {
  bonusType: CouponBonusType;
  bonusValue: number;
  minCoins: number;
  /** 0 means no upper limit. */
  maxCoins: number;
  expiresAt: Date | null;
  isActive: boolean;
}

export type CouponRejection =
  | "inactive"
  | "expired"
  | "below-minimum"
  | "above-maximum";

export interface CouponResult {
  ok: boolean;
  bonus: number;
  reason?: CouponRejection;
  message?: string;
}

export function evaluateCoupon(coupon: CouponLike, coinAmount: number): CouponResult {
  if (!coupon.isActive) {
    return { ok: false, bonus: 0, reason: "inactive", message: "This code is no longer active." };
  }

  if (coupon.expiresAt && coupon.expiresAt.getTime() <= Date.now()) {
    return { ok: false, bonus: 0, reason: "expired", message: "This code has expired." };
  }

  if (coinAmount < coupon.minCoins) {
    return {
      ok: false,
      bonus: 0,
      reason: "below-minimum",
      message: `This code needs a request of at least ${coupon.minCoins} coins.`,
    };
  }

  if (coupon.maxCoins > 0 && coinAmount > coupon.maxCoins) {
    return {
      ok: false,
      bonus: 0,
      reason: "above-maximum",
      message: `This code only applies to requests up to ${coupon.maxCoins} coins.`,
    };
  }

  const bonus =
    coupon.bonusType === "PERCENTAGE"
      ? // Rounded down: a percentage bonus should never round up into a
        // coin the rule didn't earn.
        Math.floor((coinAmount * coupon.bonusValue) / 100)
      : coupon.bonusValue;

  return { ok: true, bonus: Math.max(bonus, 0) };
}
