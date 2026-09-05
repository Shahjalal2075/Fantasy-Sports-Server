import { Request, Response } from "express";
import { z } from "zod";
import prisma from "../config/prisma";
import {
  approveCoinRequest,
  createCoinRequest,
  previewCoupon,
  rejectAllOpen,
  setCoinRequestStatus,
} from "../services/coinRequestService";

// ---------- User ----------

// GET /api/coin-requests/config  (auth)
export async function getCoinRequestConfig(req: Request, res: Response) {
  const [settings, agents, open] = await Promise.all([
    prisma.appSettings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} }),
    prisma.requestAgent.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { id: true, name: true, logoUrl: true, method: true, number: true },
    }),
    prisma.coinRequest.count({
      where: { userId: req.userId as string, status: { in: ["PENDING", "HELD"] } },
    }),
  ]);

  return res.status(200).json({
    config: {
      // With no agents there's nobody to review a request, so the form
      // stays closed whatever the toggle says.
      enabled: settings.coinRequestEnabled && agents.length > 0,
      minCoins: settings.coinRequestMinCoins,
      maxPending: settings.coinRequestMaxPending,
      messengerUrl: settings.coinRequestMessenger,
      telegramUrl: settings.coinRequestTelegram,
      note: settings.coinRequestNote,
    },
    agents,
    openRequests: open,
  });
}

const previewSchema = z.object({
  code: z.string().min(1).max(24),
  coinAmount: z.number().int().min(1).max(1_000_000),
});

// POST /api/coin-requests/preview-coupon  (auth)
export async function previewCouponHandler(req: Request, res: Response) {
  const parsed = previewSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  return res.status(200).json(await previewCoupon(parsed.data.code, parsed.data.coinAmount));
}

const createSchema = z.object({
  coinAmount: z.number().int().positive("Enter how many coins you'd like"),
  agentId: z.string().uuid("Choose an agent"),
  // Matches the form's own limit.
  reason: z.string().min(1, "Give a short reason").max(16),
  couponCode: z.string().max(24).optional(),
});

// POST /api/coin-requests  (auth)
export async function submitCoinRequest(req: Request, res: Response) {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const result = await createCoinRequest({ userId: req.userId as string, ...parsed.data });
  if (!result.ok) return res.status(400).json({ error: result.error });

  return res.status(201).json({ requestId: result.requestId });
}

// GET /api/coin-requests/my  (auth)
export async function myCoinRequests(req: Request, res: Response) {
  const requests = await prisma.coinRequest.findMany({
    where: { userId: req.userId as string },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      status: true,
      coinAmount: true,
      bonusAmount: true,
      totalAmount: true,
      reason: true,
      couponCode: true,
      agentName: true,
      agentLogo: true,
      adminNote: true,
      resolvedAt: true,
      createdAt: true,
    },
  });

  return res.status(200).json({ requests });
}

// ---------- Admin ----------

// GET /api/admin/coin-requests?status=
export async function listCoinRequests(req: Request, res: Response) {
  const status = typeof req.query.status === "string" ? req.query.status : null;

  const requests = await prisma.coinRequest.findMany({
    where: status && status !== "ALL" ? { status: status as any } : undefined,
    // Newest first: the decision is always about today's batch.
    orderBy: { createdAt: "desc" },
    take: 300,
    include: {
      user: { select: { id: true, name: true, username: true, coins: true, isVerified: true } },
    },
  });

  const counts = await prisma.coinRequest.groupBy({
    by: ["status"],
    _count: { status: true },
  });

  return res.status(200).json({
    requests,
    counts: Object.fromEntries(counts.map((row) => [row.status, row._count.status])),
  });
}

// POST /api/admin/coin-requests/:id/approve
export async function approveHandler(req: Request, res: Response) {
  const { id } = req.params as { id: string };
  const note = typeof req.body?.note === "string" ? req.body.note : "";

  const result = await approveCoinRequest(id, note);
  if (!result.ok) return res.status(400).json({ error: result.error });

  return res.status(200).json({ message: "Approved", credited: result.credited });
}

// POST /api/admin/coin-requests/:id/hold      body: { note }
// POST /api/admin/coin-requests/:id/reject    body: { note }
/** Builds the hold and reject handlers — they differ only in status. */
export function decisionHandler(status: "HELD" | "REJECTED") {
  return async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    const note = typeof req.body?.note === "string" ? req.body.note : "";

    const result = await setCoinRequestStatus(id, status, note);
    if (!result.ok) return res.status(400).json({ error: result.error });

    return res.status(200).json({ message: status === "HELD" ? "Held" : "Rejected" });
  };
}

// POST /api/admin/coin-requests/reject-all   body: { note }
export async function rejectAllHandler(req: Request, res: Response) {
  const note = typeof req.body?.note === "string" ? req.body.note : "";
  if (!note.trim()) {
    return res.status(400).json({ error: "Give a reason — every user will be told it." });
  }

  const count = await rejectAllOpen(note);
  return res.status(200).json({ message: `Rejected ${count} requests`, count });
}

// ---------- Admin: agents ----------

const agentSchema = z.object({
  name: z.string().min(1, "Enter the agent's name").max(60),
  logoUrl: z.string().url().or(z.literal("")).optional(),
  method: z.string().max(40).optional(),
  number: z.string().max(40).optional(),
  sortOrder: z.number().int().min(0).max(999).optional(),
  isActive: z.boolean().optional(),
});

export async function listAgents(_req: Request, res: Response) {
  const agents = await prisma.requestAgent.findMany({
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  return res.status(200).json({ agents });
}

export async function createAgent(req: Request, res: Response) {
  const parsed = agentSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const last = await prisma.requestAgent.findFirst({ orderBy: { sortOrder: "desc" } });

  const agent = await prisma.requestAgent.create({
    data: {
      name: parsed.data.name.trim(),
      logoUrl: parsed.data.logoUrl ?? "",
      method: parsed.data.method?.trim() ?? "",
      number: parsed.data.number?.trim() ?? "",
      sortOrder: parsed.data.sortOrder ?? (last ? last.sortOrder + 1 : 0),
      isActive: parsed.data.isActive ?? true,
    },
  });

  return res.status(201).json({ agent });
}

export async function updateAgent(req: Request, res: Response) {
  const { id } = req.params as { id: string };

  const parsed = agentSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const existing = await prisma.requestAgent.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: "Agent not found" });

  const agent = await prisma.requestAgent.update({ where: { id }, data: parsed.data });
  return res.status(200).json({ agent });
}

// Agents are deactivated rather than deleted: past requests snapshot the
// name and logo, but the relation is what ties them together.
export async function deleteAgent(req: Request, res: Response) {
  const { id } = req.params as { id: string };

  await prisma.requestAgent.update({ where: { id }, data: { isActive: false } });
  return res.status(200).json({ message: "Agent switched off" });
}

// ---------- Admin: coupons ----------

const couponSchema = z.object({
  code: z.string().min(2, "Enter a code").max(24),
  bonusType: z.enum(["FIXED", "PERCENTAGE"]),
  bonusValue: z.number().int().min(0).max(100_000),
  minCoins: z.number().int().min(0).max(1_000_000).optional(),
  maxCoins: z.number().int().min(0).max(1_000_000).optional(),
  expiresAt: z.string().datetime().or(z.literal("")).optional(),
  isActive: z.boolean().optional(),
});

export async function listCoupons(_req: Request, res: Response) {
  const coupons = await prisma.coinCoupon.findMany({ orderBy: { createdAt: "desc" } });
  return res.status(200).json({ coupons });
}

export async function createCoupon(req: Request, res: Response) {
  const parsed = couponSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const code = parsed.data.code.trim().toUpperCase();

  const clash = await prisma.coinCoupon.findUnique({ where: { code } });
  if (clash) return res.status(409).json({ error: "That code already exists." });

  if (parsed.data.bonusType === "PERCENTAGE" && parsed.data.bonusValue > 100) {
    return res.status(400).json({ error: "A percentage bonus can't be over 100." });
  }

  const coupon = await prisma.coinCoupon.create({
    data: {
      code,
      bonusType: parsed.data.bonusType,
      bonusValue: parsed.data.bonusValue,
      minCoins: parsed.data.minCoins ?? 0,
      maxCoins: parsed.data.maxCoins ?? 0,
      expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
      isActive: parsed.data.isActive ?? true,
    },
  });

  return res.status(201).json({ coupon });
}

export async function updateCoupon(req: Request, res: Response) {
  const { id } = req.params as { id: string };

  const parsed = couponSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const { expiresAt, code, ...rest } = parsed.data;

  const coupon = await prisma.coinCoupon.update({
    where: { id },
    data: {
      ...rest,
      ...(code ? { code: code.trim().toUpperCase() } : {}),
      ...(expiresAt !== undefined ? { expiresAt: expiresAt ? new Date(expiresAt) : null } : {}),
    },
  });

  return res.status(200).json({ coupon });
}

export async function deleteCoupon(req: Request, res: Response) {
  const { id } = req.params as { id: string };

  // Kept, not deleted: past requests reference it, and the code on a
  // request should stay explainable.
  await prisma.coinCoupon.update({ where: { id }, data: { isActive: false } });
  return res.status(200).json({ message: "Coupon switched off" });
}
