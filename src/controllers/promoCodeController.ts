import { Request, Response } from "express";
import prisma from "../config/prisma";
import { CoinTransactionType } from "../generated/prisma/client";
import { createPromoCodeSchema, updatePromoCodeSchema } from "../utils/validators";
import { creditCoins } from "../services/walletService";

// ---------- Admin ----------

// GET /api/promo-codes  (admin only) — list with claim counts
export async function listPromoCodes(req: Request, res: Response) {
  const codes = await prisma.promoCode.findMany({
    include: { _count: { select: { claims: true } } },
    orderBy: { createdAt: "desc" },
  });

  return res.status(200).json({
    promoCodes: codes.map((c) => ({
      id: c.id,
      code: c.code,
      coinAmount: c.coinAmount,
      maxClaims: c.maxClaims,
      claimCount: c._count.claims,
      expiresAt: c.expiresAt,
      isActive: c.isActive,
      isExpired: new Date() >= c.expiresAt,
      createdAt: c.createdAt,
    })),
  });
}

// POST /api/promo-codes  (admin only)
export async function createPromoCode(req: Request, res: Response) {
  const parsed = createPromoCodeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const { code, coinAmount, maxClaims, validDays } = parsed.data;
  const expiresAt = new Date(Date.now() + validDays * 24 * 60 * 60 * 1000);

  try {
    const promoCode = await prisma.promoCode.create({
      data: { code: code.toUpperCase(), coinAmount, maxClaims, expiresAt },
    });
    return res.status(201).json({ promoCode });
  } catch (err: any) {
    if (err.code === "P2002") {
      return res.status(409).json({ error: "This promo code already exists" });
    }
    throw err;
  }
}

// PATCH /api/promo-codes/:id  (admin only) — mainly for deactivating early
export async function updatePromoCode(req: Request, res: Response) {
  const { id } = req.params as { id: string };

  const parsed = updatePromoCodeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const existing = await prisma.promoCode.findUnique({ where: { id } });
  if (!existing) {
    return res.status(404).json({ error: "Promo code not found" });
  }

  const promoCode = await prisma.promoCode.update({ where: { id }, data: parsed.data });
  return res.status(200).json({ promoCode });
}

// DELETE /api/promo-codes/:id  (admin only)
export async function deletePromoCode(req: Request, res: Response) {
  const { id } = req.params as { id: string };

  const existing = await prisma.promoCode.findUnique({ where: { id } });
  if (!existing) {
    return res.status(404).json({ error: "Promo code not found" });
  }

  await prisma.promoCode.delete({ where: { id } });
  return res.status(200).json({ message: "Promo code deleted" });
}

// ---------- User ----------

// POST /api/promo-codes/claim  (auth required)  body: { code }
export async function claimPromoCode(req: Request, res: Response) {
  const userId = req.userId as string;
  const { code } = req.body as { code?: string };

  if (!code || typeof code !== "string") {
    return res.status(400).json({ error: "Promo code is required" });
  }

  const promoCode = await prisma.promoCode.findUnique({
    where: { code: code.trim().toUpperCase() },
    include: { _count: { select: { claims: true } } },
  });

  if (!promoCode || !promoCode.isActive) {
    return res.status(404).json({ error: "Invalid promo code" });
  }
  if (new Date() >= promoCode.expiresAt) {
    return res.status(400).json({ error: "This promo code has expired" });
  }
  if (promoCode._count.claims >= promoCode.maxClaims) {
    return res.status(400).json({ error: "This promo code has reached its claim limit" });
  }

  const existingClaim = await prisma.promoCodeClaim.findUnique({
    where: { promoCodeId_userId: { promoCodeId: promoCode.id, userId } },
  });
  if (existingClaim) {
    return res.status(409).json({ error: "You've already claimed this promo code" });
  }

  try {
    const newBalance = await prisma.$transaction(async (tx) => {
      await tx.promoCodeClaim.create({ data: { promoCodeId: promoCode.id, userId } });
      return creditCoins(tx, userId, promoCode.coinAmount, CoinTransactionType.PROMO_CODE, {
        reason: `Promo code: ${promoCode.code}`,
      });
    });

    return res.status(200).json({ message: "Promo code claimed", coinsAwarded: promoCode.coinAmount, coins: newBalance });
  } catch (err: any) {
    if (err.code === "P2002") {
      return res.status(409).json({ error: "You've already claimed this promo code" });
    }
    throw err;
  }
}
