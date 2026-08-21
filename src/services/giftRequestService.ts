import prisma from "../config/prisma";
import { creditCoins, debitCoins } from "./walletService";

async function loadSettings() {
  return prisma.appSettings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
}

/**
 * Refunds any pending request whose expiry has passed.
 *
 * Run opportunistically from the request and admin-list endpoints rather
 * than on a schedule — this project has no cron, and the important
 * guarantee is only that coins come back, not that they come back within
 * the same second the deadline passes.
 *
 * Returns how many were expired, mostly so the admin list can mention it.
 */
export async function expireStaleRequests(): Promise<number> {
  const stale = await prisma.giftRequest.findMany({
    where: { status: "PENDING", expiresAt: { lte: new Date() } },
    select: { id: true, userId: true, coinAmount: true },
    take: 100,
  });

  if (stale.length === 0) return 0;

  let expired = 0;

  for (const request of stale) {
    await prisma.$transaction(async (tx) => {
      // Guarded update: if an admin resolved this request a moment ago,
      // this matches nothing and we skip the refund entirely rather than
      // paying it out twice.
      const claimed = await tx.giftRequest.updateMany({
        where: { id: request.id, status: "PENDING" },
        data: {
          status: "CANCELLED",
          cancelReason: "Automatically cancelled — not reviewed within the request window.",
          resolvedAt: new Date(),
        },
      });
      if (claimed.count === 0) return;

      await creditCoins(tx, request.userId, request.coinAmount, "GIFT_REFUND", {
        reason: "Gift request expired — coins returned",
      });

      await tx.notification.create({
        data: {
          userId: request.userId,
          type: "COIN_BONUS",
          title: "Coins returned",
          message: `Your gift request wasn't selected this time, so ${request.coinAmount.toLocaleString()} coins have been returned to your balance.`,
          coinAmount: request.coinAmount,
        },
      });

      expired += 1;
    });
  }

  return expired;
}

/**
 * Creates a request and holds the coins.
 *
 * The debit runs through walletService, whose conditional update means a
 * user firing two requests at once can't go negative.
 */
export async function createGiftRequest(input: {
  userId: string;
  coinAmount: number;
  contactMethodId: string;
  contactNumber: string;
}): Promise<{ ok: true; requestId: string } | { ok: false; error: string }> {
  const settings = await loadSettings();

  if (!settings.giftRequestsEnabled) {
    return { ok: false, error: "Gift requests are closed at the moment. Please check back later." };
  }

  if (input.coinAmount < settings.giftRequestMinCoins) {
    return {
      ok: false,
      error: `The minimum request is ${settings.giftRequestMinCoins.toLocaleString()} coins.`,
    };
  }

  // One open request at a time keeps the admin queue readable and stops
  // a user tying up their whole balance across many rows.
  const openRequest = await prisma.giftRequest.findFirst({
    where: { userId: input.userId, status: "PENDING" },
  });
  if (openRequest) {
    return {
      ok: false,
      error: "You already have a request under review. You can send another once it's resolved.",
    };
  }

  // Rate limit regardless of outcome: without this, a user whose request
  // was cancelled could immediately resubmit and flood the queue.
  if (settings.giftRequestCooldownHours > 0) {
    const cooldownMs = settings.giftRequestCooldownHours * 60 * 60 * 1000;
    const recent = await prisma.giftRequest.findFirst({
      where: { userId: input.userId, createdAt: { gte: new Date(Date.now() - cooldownMs) } },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });

    if (recent) {
      const nextAllowedAt = new Date(recent.createdAt.getTime() + cooldownMs);
      const hoursLeft = Math.ceil((nextAllowedAt.getTime() - Date.now()) / (60 * 60 * 1000));
      return {
        ok: false,
        error: `You can send one request every ${settings.giftRequestCooldownHours} hours. Please try again in about ${hoursLeft} hour${hoursLeft === 1 ? "" : "s"}.`,
      };
    }
  }

  const method = await prisma.contactMethod.findUnique({ where: { id: input.contactMethodId } });
  if (!method || !method.isActive) {
    return { ok: false, error: "Pick a contact method." };
  }

  const expiresAt = new Date(Date.now() + settings.giftRequestExpiryDays * 24 * 60 * 60 * 1000);

  try {
    const request = await prisma.$transaction(async (tx) => {
      await debitCoins(tx, input.userId, input.coinAmount, "GIFT_REQUEST", {
        reason: "Gift request submitted",
      });

      return tx.giftRequest.create({
        data: {
          userId: input.userId,
          coinAmount: input.coinAmount,
          contactMethodId: method.id,
          // Snapshot: if this method is deleted later, the request still
          // shows how the user asked to be contacted.
          contactMethodName: method.name,
          contactMethodLogo: method.logoUrl,
          contactNumber: input.contactNumber,
          expiresAt,
        },
      });
    });

    return { ok: true, requestId: request.id };
  } catch (err: any) {
    // debitCoins throws when the balance is short.
    return { ok: false, error: err?.message ?? "Couldn't submit your request. Please try again." };
  }
}

/** Admin approves: the hold becomes a spend, and a gift is on its way. */
export async function approveGiftRequest(
  requestId: string,
  adminId: string,
  trackingId: string
): Promise<{ ok: boolean; error?: string }> {
  if (!trackingId.trim()) {
    return { ok: false, error: "A tracking ID is required to approve a request." };
  }

  const request = await prisma.giftRequest.findUnique({ where: { id: requestId } });
  if (!request) return { ok: false, error: "Request not found" };
  if (request.status !== "PENDING") {
    return { ok: false, error: `This request has already been ${request.status.toLowerCase()}.` };
  }

  await prisma.$transaction(async (tx) => {
    const claimed = await tx.giftRequest.updateMany({
      where: { id: requestId, status: "PENDING" },
      data: {
        status: "APPROVED",
        trackingId: trackingId.trim(),
        resolvedAt: new Date(),
        resolvedById: adminId,
      },
    });
    if (claimed.count === 0) return;

    // No coin movement here — they were already debited at request time.
    await tx.notification.create({
      data: {
        userId: request.userId,
        type: "GENERIC",
        title: "Your gift is on the way!",
        message: `Your gift request was approved. Tracking ID: ${trackingId.trim()}. We'll contact you on the number you provided.`,
      },
    });
  });

  return { ok: true };
}

/** Admin cancels: coins go straight back. */
export async function cancelGiftRequest(
  requestId: string,
  adminId: string,
  cancelReason: string
): Promise<{ ok: boolean; error?: string }> {
  if (!cancelReason.trim()) {
    return { ok: false, error: "A reason is required when cancelling a request." };
  }

  const request = await prisma.giftRequest.findUnique({ where: { id: requestId } });
  if (!request) return { ok: false, error: "Request not found" };
  if (request.status !== "PENDING") {
    return { ok: false, error: `This request has already been ${request.status.toLowerCase()}.` };
  }

  await prisma.$transaction(async (tx) => {
    const claimed = await tx.giftRequest.updateMany({
      where: { id: requestId, status: "PENDING" },
      data: {
        status: "CANCELLED",
        cancelReason: cancelReason.trim(),
        resolvedAt: new Date(),
        resolvedById: adminId,
      },
    });
    // Guarded so a double-click can't refund twice.
    if (claimed.count === 0) return;

    await creditCoins(tx, request.userId, request.coinAmount, "GIFT_REFUND", {
      reason: "Gift request cancelled — coins returned",
    });

    await tx.notification.create({
      data: {
        userId: request.userId,
        type: "COIN_BONUS",
        title: "Coins returned",
        message:
          `${request.coinAmount.toLocaleString()} coins have been returned to your balance.\n\nReason: ${cancelReason.trim()}`,
        coinAmount: request.coinAmount,
      },
    });
  });

  return { ok: true };
}
