import { Request, Response } from "express";
import prisma from "../config/prisma";
import { z } from "zod";
import { invalidateBannersCache } from "./appConfigController";

const bannerSchema = z.object({
  imageUrl: z.string().url("Upload an image first"),
  // Blank is allowed and means "decorative, not tappable".
  linkUrl: z.string().url("Enter a valid link").or(z.literal("")).optional(),
  title: z.string().max(60).optional(),
  sortOrder: z.number().int().min(0).max(999).optional(),
  isActive: z.boolean().optional(),
});

// Everything is optional on update so the admin panel can toggle just
// `isActive` or nudge `sortOrder` without resending the image.
const bannerUpdateSchema = bannerSchema.partial();

// GET /api/admin/banners  (admin only) — all banners, including parked ones
export async function listBanners(_req: Request, res: Response) {
  const banners = await prisma.banner.findMany({
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  return res.status(200).json({ banners });
}

// POST /api/admin/banners  (admin only)
export async function createBanner(req: Request, res: Response) {
  const parsed = bannerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  // Default to the end of the list rather than 0, so a new banner never
  // silently jumps ahead of the existing ones.
  const last = await prisma.banner.findFirst({ orderBy: { sortOrder: "desc" } });

  const banner = await prisma.banner.create({
    data: {
      imageUrl: parsed.data.imageUrl,
      linkUrl: parsed.data.linkUrl ?? "",
      title: parsed.data.title ?? "",
      sortOrder: parsed.data.sortOrder ?? (last ? last.sortOrder + 1 : 0),
      isActive: parsed.data.isActive ?? true,
    },
  });

  invalidateBannersCache();
  return res.status(201).json({ banner });
}

// PATCH /api/admin/banners/:id  (admin only)
export async function updateBanner(req: Request, res: Response) {
  const { id } = req.params as { id: string };

  const parsed = bannerUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const existing = await prisma.banner.findUnique({ where: { id } });
  if (!existing) {
    return res.status(404).json({ error: "Banner not found" });
  }

  const banner = await prisma.banner.update({ where: { id }, data: parsed.data });

  invalidateBannersCache();
  return res.status(200).json({ banner });
}

// DELETE /api/admin/banners/:id  (admin only)
export async function deleteBanner(req: Request, res: Response) {
  const { id } = req.params as { id: string };

  const existing = await prisma.banner.findUnique({ where: { id } });
  if (!existing) {
    return res.status(404).json({ error: "Banner not found" });
  }

  await prisma.banner.delete({ where: { id } });

  invalidateBannersCache();
  return res.status(200).json({ message: "Banner deleted" });
}

/** Active banners in slider order — used by the public app config. */
export async function getActiveBanners() {
  return prisma.banner.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: { id: true, imageUrl: true, linkUrl: true },
  });
}
