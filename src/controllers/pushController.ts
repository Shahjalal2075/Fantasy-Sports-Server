import { Request, Response } from "express";
import { z } from "zod";
import prisma from "../config/prisma";
import { pushToEveryone } from "../services/pushService";

const registerSchema = z.object({
  token: z.string().min(10, "Invalid push token"),
  platform: z.string().max(20).optional(),
  deviceId: z.string().max(120).optional(),
});

// POST /api/push/register  (auth required)
// The app calls this whenever it obtains or refreshes an Expo token.
export async function registerPushToken(req: Request, res: Response) {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const userId = req.userId as string;

  // Upsert on the token: the same device reinstalling or a different
  // user signing in on it should move the row, not create a duplicate.
  await prisma.pushToken.upsert({
    where: { token: parsed.data.token },
    create: {
      token: parsed.data.token,
      userId,
      platform: parsed.data.platform ?? "android",
      deviceId: parsed.data.deviceId ?? "",
    },
    update: {
      userId,
      platform: parsed.data.platform ?? "android",
      deviceId: parsed.data.deviceId ?? "",
      isActive: true,
      lastUsedAt: new Date(),
    },
  });

  return res.status(200).json({ message: "Push token registered" });
}

// POST /api/push/unregister  (auth required) — called on logout
export async function unregisterPushToken(req: Request, res: Response) {
  const token = typeof req.body?.token === "string" ? req.body.token : "";
  if (!token) {
    return res.status(400).json({ error: "token is required" });
  }

  // Deactivate rather than delete, so the row's history survives and a
  // re-login can simply reactivate it.
  await prisma.pushToken.updateMany({
    where: { token, userId: req.userId as string },
    data: { isActive: false },
  });

  return res.status(200).json({ message: "Push token removed" });
}

// ---------- Admin ----------

const campaignSchema = z.object({
  title: z.string().min(1, "Enter a title").max(80),
  body: z.string().min(1, "Enter a message").max(300),
  linkTo: z.string().max(40).optional(),
  // Absent means "send right now".
  scheduledFor: z.string().datetime().optional().or(z.literal("")),
});

// GET /api/admin/push-campaigns
export async function listCampaigns(_req: Request, res: Response) {
  const campaigns = await prisma.pushCampaign.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  const activeDevices = await prisma.pushToken.count({ where: { isActive: true } });

  return res.status(200).json({ campaigns, activeDevices });
}

// POST /api/admin/push-campaigns
export async function createCampaign(req: Request, res: Response) {
  const parsed = campaignSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const { title, body, linkTo } = parsed.data;
  const scheduledFor = parsed.data.scheduledFor ? new Date(parsed.data.scheduledFor) : null;

  // Send immediately when no time is given, or when the given time has
  // already passed (an admin picking "now" shouldn't wait for the next
  // scheduler pass).
  const sendNow = !scheduledFor || scheduledFor <= new Date();

  const campaign = await prisma.pushCampaign.create({
    data: {
      title,
      body,
      linkTo: linkTo ?? "",
      scheduledFor,
      status: "SCHEDULED",
    },
  });

  if (!sendNow) {
    return res.status(201).json({ campaign });
  }

  try {
    const result = await pushToEveryone({ title, body, linkTo });
    const sent = await prisma.pushCampaign.update({
      where: { id: campaign.id },
      data: {
        status: "SENT",
        sentAt: new Date(),
        sentCount: result.sent,
        failedCount: result.failed,
      },
    });
    return res.status(201).json({ campaign: sent });
  } catch (err) {
    const failed = await prisma.pushCampaign.update({
      where: { id: campaign.id },
      data: { status: "FAILED", error: String(err).slice(0, 400) },
    });
    return res.status(500).json({ campaign: failed, error: "Push failed to send" });
  }
}

// DELETE /api/admin/push-campaigns/:id — cancels a scheduled send
export async function cancelCampaign(req: Request, res: Response) {
  const { id } = req.params as { id: string };

  const campaign = await prisma.pushCampaign.findUnique({ where: { id } });
  if (!campaign) {
    return res.status(404).json({ error: "Campaign not found" });
  }
  if (campaign.status !== "SCHEDULED") {
    return res.status(400).json({ error: "Only scheduled notifications can be cancelled." });
  }

  const updated = await prisma.pushCampaign.update({
    where: { id },
    data: { status: "CANCELLED" },
  });

  return res.status(200).json({ campaign: updated });
}
