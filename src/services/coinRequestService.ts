import prisma from "../config/prisma";
import { evaluateCoupon } from "../utils/coinCoupons";
import { creditCoins } from "./walletService";
import { sendPush } from "./pushService";

/**
 * Coin requests.
 *
 * A user asks an agent for coins and gives a reason; the agent decides.
 * No money is involved and most requests are refused — this is a reward
 * channel, not a purchase.
 */

async function loadSettings() {
  return prisma.appSettings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
}

/** Held requests count as open: parking one must not free up a slot. */
const OPEN_STATUSES = ["PENDING", "HELD"] as const;

export interface CouponPreview {
  ok: boolean;
  code: string;
  bonus: number;
  message?: string;
}

/**
 * Checks a code against an amount without committing to anything.
 *
 * Used by the form as the user types, so the bonus they see is computed
 * by exactly the same rule that will run at approval.
 */
export async function previewCoupon(code: string, coinAmount: number): Promise<CouponPreview> {
  const trimmed = code.trim().toUpperCase();
  if (!trimmed) return { ok: false, code: "", bonus: 0 };

  const coupon = await prisma.coinCoupon.findUnique({ where: { code: trimmed } });
  if (!coupon) {
    return { ok: false, code: trimmed, bonus: 0, message: "That code doesn't exist." };
  }

  const result = evaluateCoupon(coupon, coinAmount);
  return { ok: result.ok, code: trimmed, bonus: result.bonus, message: result.message };
}

export interface CreateRequestInput {
  userId: string;
  coinAmount: number;
  agentId: string;
  reason: string;
  couponCode?: string;
}

export async function createCoinRequest(
  input: CreateRequestInput
): Promise<{ ok: true; requestId: string } | { ok: false; error: string }> {
  const settings = await loadSettings();

  if (!settings.coinRequestEnabled) {
    return { ok: false, error: "Coin requests are closed at the moment." };
  }

  if (input.coinAmount < settings.coinRequestMinCoins) {
    return { ok: false, error: `The smallest request is ${settings.coinRequestMinCoins} coins.` };
  }

  // A cap on open requests, not on requests per day. Someone can ask as
  // often as they like — they just can't queue up an unbounded pile
  // waiting on an agent.
  const open = await prisma.coinRequest.count({
    where: { userId: input.userId, status: { in: [...OPEN_STATUSES] } },
  });

  if (open >= settings.coinRequestMaxPending) {
    return {
      ok: false,
      error: `You already have ${open} requests waiting. Wait for one to be decided before sending another.`,
    };
  }

  const agent = await prisma.requestAgent.findUnique({ where: { id: input.agentId } });
  if (!agent || !agent.isActive) {
    return { ok: false, error: "Choose an agent to send this request to." };
  }

  // Resolve the coupon now so the user's figures are recorded, but the
  // bonus is recalculated on approval — a code can expire in between.
  let couponId: string | null = null;
  let couponCode = "";
  let bonusAmount = 0;

  if (input.couponCode?.trim()) {
    const trimmed = input.couponCode.trim().toUpperCase();
    const coupon = await prisma.coinCoupon.findUnique({ where: { code: trimmed } });

    if (!coupon) return { ok: false, error: "That code doesn't exist." };

    const result = evaluateCoupon(coupon, input.coinAmount);
    if (!result.ok) return { ok: false, error: result.message ?? "That code can't be used here." };

    couponId = coupon.id;
    couponCode = trimmed;
    bonusAmount = result.bonus;
  }

  const request = await prisma.coinRequest.create({
    data: {
      userId: input.userId,
      coinAmount: input.coinAmount,
      bonusAmount,
      totalAmount: input.coinAmount + bonusAmount,
      reason: input.reason.trim().slice(0, 16),

      agentId: agent.id,
      // Snapshotted: editing or removing an agent later must not rewrite
      // what the user saw when they sent this.
      agentName: agent.name,
      agentLogo: agent.logoUrl,
      agentMethod: agent.method,
      agentNumber: agent.number,

      couponId,
      couponCode,
    },
  });

  return { ok: true, requestId: request.id };
}

/**
 * Grants a request.
 *
 * The bonus is recomputed rather than taken from the stored figure: a
 * coupon may have expired or been switched off since, and paying on a
 * stale calculation is how a rule quietly stops meaning anything.
 */
export async function approveCoinRequest(
  requestId: string,
  note: string
): Promise<{ ok: boolean; error?: string; credited?: number }> {
  const request = await prisma.coinRequest.findUnique({
    where: { id: requestId },
    include: { coupon: true },
  });

  if (!request) return { ok: false, error: "Request not found" };
  if (request.status === "APPROVED") {
    return { ok: false, error: "This request has already been approved." };
  }

  let bonusAmount = 0;
  if (request.coupon) {
    const result = evaluateCoupon(request.coupon, request.coinAmount);
    if (result.ok) bonusAmount = result.bonus;
  }

  const totalAmount = request.coinAmount + bonusAmount;

  await prisma.$transaction(async (tx) => {
    // Conditional claim: two admins approving at once must not pay twice.
    const claimed = await tx.coinRequest.updateMany({
      where: { id: requestId, status: { not: "APPROVED" } },
      data: {
        status: "APPROVED",
        bonusAmount,
        totalAmount,
        adminNote: note.trim(),
        resolvedAt: new Date(),
      },
    });
    if (claimed.count === 0) return;

    // Granted coins are deposit coins: spendable on contests, never
    // redeemable for a gift. Only contest winnings are.
    await creditCoins(tx, request.userId, totalAmount, "COIN_REQUEST", {
      reason: note.trim() || `Coin request approved by ${request.agentName || "an agent"}`,
    });

    await tx.notification.create({
      data: {
        userId: request.userId,
        type: "COIN_BONUS",
        title: `${totalAmount.toLocaleString()} coins added`,
        message:
          bonusAmount > 0
            ? `Your request for ${request.coinAmount.toLocaleString()} coins was approved, with a ${bonusAmount.toLocaleString()} coin bonus from ${request.couponCode}.`
            : `Your request for ${request.coinAmount.toLocaleString()} coins was approved.`,
        coinAmount: totalAmount,
      },
    });
  });

  await sendPush({
    event: "COIN_REQUEST_APPROVED",
    vars: {
      total: totalAmount,
      requested: request.coinAmount,
      bonus: bonusAmount,
      coupon: request.couponCode,
      agent: request.agentName,
    },
    userIds: [request.userId],
  });

  return { ok: true, credited: totalAmount };
}

export async function setCoinRequestStatus(
  requestId: string,
  status: "HELD" | "REJECTED",
  note: string
): Promise<{ ok: boolean; error?: string }> {
  if (!note.trim()) {
    return {
      ok: false,
      error: status === "HELD" ? "Give a reason for holding this." : "Give a reason for rejecting this.",
    };
  }

  const request = await prisma.coinRequest.findUnique({ where: { id: requestId } });
  if (!request) return { ok: false, error: "Request not found" };
  if (request.status === "APPROVED") {
    return { ok: false, error: "This request was already approved." };
  }

  await prisma.coinRequest.update({
    where: { id: requestId },
    data: {
      status,
      adminNote: note.trim(),
      // A held request is still open, so it has no resolution time.
      resolvedAt: status === "REJECTED" ? new Date() : null,
    },
  });

  await prisma.notification.create({
    data: {
      userId: request.userId,
      type: "GENERIC",
      title: status === "HELD" ? "Your coin request is on hold" : "Your coin request wasn't approved",
      message: note.trim(),
    },
  });

  await sendPush({
    event: "COIN_REQUEST_DECLINED",
    vars: { reason: note.trim(), requested: request.coinAmount, agent: request.agentName },
    userIds: [request.userId],
  });

  return { ok: true };
}

/**
 * Rejects everything still open.
 *
 * The day's requests are reviewed together and usually only one is
 * granted, so clearing the rest one at a time would be tedious. Approved
 * requests are never touched.
 */
export async function rejectAllOpen(note: string): Promise<number> {
  const open = await prisma.coinRequest.findMany({
    where: { status: { in: [...OPEN_STATUSES] } },
    select: { id: true, userId: true },
  });

  if (open.length === 0) return 0;

  await prisma.$transaction([
    prisma.coinRequest.updateMany({
      where: { id: { in: open.map((row) => row.id) } },
      data: { status: "REJECTED", adminNote: note.trim(), resolvedAt: new Date() },
    }),
    prisma.notification.createMany({
      data: open.map((row) => ({
        userId: row.userId,
        type: "GENERIC" as const,
        title: "Your coin request wasn't approved",
        message: note.trim(),
      })),
    }),
  ]);

  // One call for the whole batch rather than one per user: a day's
  // rejections can run to hundreds.
  await sendPush({
    event: "COIN_REQUEST_DECLINED",
    vars: { reason: note.trim() },
    userIds: open.map((row) => row.userId),
  });

  return open.length;
}
