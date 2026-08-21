import { Request, Response } from "express";
import { z } from "zod";
import prisma from "../config/prisma";

const methodSchema = z.object({
  name: z.string().min(1, "Enter a name, e.g. WhatsApp").max(40),
  logoUrl: z.string().url("Upload a logo first").or(z.literal("")).optional(),
  sortOrder: z.number().int().min(0).max(999).optional(),
  isActive: z.boolean().optional(),
});

// Partial so the admin can flip `isActive` or nudge order without
// resending the logo.
const methodUpdateSchema = methodSchema.partial();

// GET /api/admin/contact-methods  (admin only) — includes hidden ones
export async function listContactMethods(_req: Request, res: Response) {
  const methods = await prisma.contactMethod.findMany({
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  return res.status(200).json({ methods });
}

// POST /api/admin/contact-methods
export async function createContactMethod(req: Request, res: Response) {
  const parsed = methodSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  // New methods go to the end of the list rather than jumping to the top.
  const last = await prisma.contactMethod.findFirst({ orderBy: { sortOrder: "desc" } });

  const method = await prisma.contactMethod.create({
    data: {
      name: parsed.data.name.trim(),
      logoUrl: parsed.data.logoUrl ?? "",
      sortOrder: parsed.data.sortOrder ?? (last ? last.sortOrder + 1 : 0),
      isActive: parsed.data.isActive ?? true,
    },
  });

  return res.status(201).json({ method });
}

// PATCH /api/admin/contact-methods/:id
export async function updateContactMethod(req: Request, res: Response) {
  const { id } = req.params as { id: string };

  const parsed = methodUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const existing = await prisma.contactMethod.findUnique({ where: { id } });
  if (!existing) {
    return res.status(404).json({ error: "Contact method not found" });
  }

  const method = await prisma.contactMethod.update({ where: { id }, data: parsed.data });
  return res.status(200).json({ method });
}

// NOTE: there is deliberately no delete endpoint.
//
// Contact methods are referenced by past gift requests, and an admin
// removing "WhatsApp" months later shouldn't rewrite history. Setting
// isActive=false takes it off the request form immediately while every
// existing request keeps showing how the user asked to be contacted.
