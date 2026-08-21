import { Request, Response } from "express";
import { z } from "zod";
import prisma from "../config/prisma";
import {
  createGiftRequest,
  approveGiftRequest,
  cancelGiftRequest,
  expireStaleRequests,
} from "../services/giftRequestService";

const createSchema = z.object({
  coinAmount: z.number().int().positive("Enter how many coins you'd like to redeem"),
  contactMethodId: z.string().uuid("Pick a contact method"),
  contactNumber: z.string().min(5, "Enter your contact number").max(40),
});

// GET /api/gift-requests/config  (auth) — what the app needs to render the form
export async function getGiftConfig(_req: Request, res: Response) {
  const settings = await prisma.appSettings.upsert({
    where: { id: 1 },
    create: { id: 1 },
    update: {},
  });

  // Only active methods, in the admin's chosen order.
  const contactMethods = await prisma.contactMethod.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: { id: true, name: true, logoUrl: true },
  });

  return res.status(200).json({
    config: {
      // With no contact methods configured there's no way to reach the
      // user, so the form stays closed regardless of the toggle.
      enabled: settings.giftRequestsEnabled && contactMethods.length > 0,
      minCoins: settings.giftRequestMinCoins,
      expiryDays: settings.giftRequestExpiryDays,
      note: settings.giftRequestNote,
      contactMethods,
    },
  });
}

// POST /api/gift-requests  (auth)
export async function submitGiftRequest(req: Request, res: Response) {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  // Clear out anything that timed out before taking a new one, so a user
  // whose old request expired isn't blocked by the one-open-request rule.
  await expireStaleRequests();

  const result = await createGiftRequest({
    userId: req.userId as string,
    coinAmount: parsed.data.coinAmount,
    contactMethodId: parsed.data.contactMethodId,
    contactNumber: parsed.data.contactNumber.trim(),
  });

  if (!result.ok) {
    return res.status(400).json({ error: result.error });
  }

  return res.status(201).json({ requestId: result.requestId });
}

// GET /api/gift-requests/my  (auth)
export async function getMyGiftRequests(req: Request, res: Response) {
  await expireStaleRequests();

  const requests = await prisma.giftRequest.findMany({
    where: { userId: req.userId as string },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      coinAmount: true,
      status: true,
      trackingId: true,
      cancelReason: true,
      contactMethodName: true,
      contactMethodLogo: true,
      contactNumber: true,
      expiresAt: true,
      resolvedAt: true,
      createdAt: true,
    },
  });

  return res.status(200).json({ requests });
}

// ---------- Admin ----------

// GET /api/admin/gift-requests?status=PENDING
export async function listGiftRequests(req: Request, res: Response) {
  const expired = await expireStaleRequests();

  const status = req.query.status;
  const where =
    typeof status === "string" && ["PENDING", "APPROVED", "CANCELLED"].includes(status)
      ? { status: status as "PENDING" | "APPROVED" | "CANCELLED" }
      : {};

  const requests = await prisma.giftRequest.findMany({
    where,
    // Highest coin amount first — that's the ordering an admin picking
    // winners actually wants; ties fall back to who asked first.
    orderBy: [{ coinAmount: "desc" }, { createdAt: "asc" }],
    take: 200,
    include: {
      user: {
        select: { id: true, name: true, username: true, coins: true, isVerified: true },
      },
    },
  });

  const pendingCount = await prisma.giftRequest.count({ where: { status: "PENDING" } });

  return res.status(200).json({ requests, pendingCount, expiredJustNow: expired });
}

// POST /api/admin/gift-requests/:id/approve   body: { trackingId }  (required)
export async function approveGiftRequestHandler(req: Request, res: Response) {
  const { id } = req.params as { id: string };
  const trackingId = typeof req.body?.trackingId === "string" ? req.body.trackingId : "";

  const result = await approveGiftRequest(id, req.userId as string, trackingId);
  if (!result.ok) {
    return res.status(400).json({ error: result.error });
  }

  return res.status(200).json({ message: "Request approved" });
}

// POST /api/admin/gift-requests/:id/cancel   body: { cancelReason }  (required)
export async function cancelGiftRequestHandler(req: Request, res: Response) {
  const { id } = req.params as { id: string };
  const cancelReason = typeof req.body?.cancelReason === "string" ? req.body.cancelReason : "";

  const result = await cancelGiftRequest(id, req.userId as string, cancelReason);
  if (!result.ok) {
    return res.status(400).json({ error: result.error });
  }

  return res.status(200).json({ message: "Request cancelled and coins returned" });
}
