import { Request, Response } from "express";
import { z } from "zod";
import prisma from "../config/prisma";
import { sendPush } from "../services/pushService";
import { NotificationEvent } from "../generated/prisma/client";
import { DEFAULT_TEMPLATES, render } from "../utils/notificationTemplates";

/** Every event, in the order the admin panel groups them. */
const EVENT_GROUPS: { group: string; events: NotificationEvent[] }[] = [
  {
    group: "Match",
    events: ["MATCH_REMINDER_30", "MATCH_REMINDER_15", "MATCH_TIME_CHANGED", "NEW_CONTEST"] as never,
  },
  {
    group: "Coins",
    events: [
      "CONTEST_PRIZE",
      "ADMIN_BONUS",
      "ADMIN_FINE",
      "REFERRAL_BONUS",
      "REFERRAL_REWARD",
    ] as never,
  },
  {
    group: "Requests",
    events: [
      "COIN_REQUEST_APPROVED",
      "COIN_REQUEST_DECLINED",
      "GIFT_APPROVED",
      "GIFT_CANCELLED",
      "GIFT_EXPIRED",
    ] as never,
  },
  {
    group: "Account",
    events: [
      "ACCOUNT_VERIFIED",
      "VERIFICATION_REMOVED",
      "PASSWORD_RESET",
      "ACCOUNT_BANNED",
    ] as never,
  },
];

// ---------- App ----------

const registerSchema = z.object({
  token: z.string().min(10).max(200),
  platform: z.string().max(20).optional(),
});

/**
 * POST /api/push/register  (auth)
 *
 * Called every time the app starts. Upserting on the token rather than
 * the user matters: a device handed to a second account must move with
 * it, or notifications keep going to whoever registered it first.
 */
export async function registerToken(req: Request, res: Response) {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  await prisma.pushToken.upsert({
    where: { token: parsed.data.token },
    create: {
      token: parsed.data.token,
      userId: req.userId as string,
      platform: parsed.data.platform ?? "android",
    },
    update: {
      userId: req.userId as string,
      isActive: true,
      lastSeenAt: new Date(),
    },
  });

  return res.status(200).json({ registered: true });
}

// DELETE /api/push/register  (auth) — on sign-out
export async function unregisterToken(req: Request, res: Response) {
  const token = typeof req.body?.token === "string" ? req.body.token : "";
  if (!token) return res.status(400).json({ error: "No token given" });

  await prisma.pushToken.updateMany({
    where: { token, userId: req.userId as string },
    data: { isActive: false },
  });

  return res.status(200).json({ unregistered: true });
}

// PATCH /api/push/preference  (auth)  body: { enabled }
export async function setPushPreference(req: Request, res: Response) {
  const enabled = req.body?.enabled !== false;

  await prisma.user.update({
    where: { id: req.userId as string },
    data: { pushEnabled: enabled },
  });

  return res.status(200).json({ pushEnabled: enabled });
}

// ---------- Admin ----------

// GET /api/admin/notifications/settings
export async function getSettings(_req: Request, res: Response) {
  const rows = await prisma.notificationSetting.findMany();
  const byEvent = new Map(rows.map((row) => [row.event, row]));

  const [tokens, settings] = await Promise.all([
    prisma.pushToken.count({ where: { isActive: true, user: { pushEnabled: true } } }),
    prisma.appSettings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} }),
  ]);

  return res.status(200).json({
    groups: EVENT_GROUPS.map((group) => ({
      group: group.group,
      events: group.events.map((event) => {
        const row = byEvent.get(event);
        const template = DEFAULT_TEMPLATES[event] ?? { title: "", body: "", variables: [] };

        return {
          event,
          // Unknown means never touched, which is on for both.
          enabled: row?.enabled ?? true,
          saveInApp: row?.saveInApp ?? true,

          // Blank means the admin hasn't overridden it; the panel shows
          // the default as a placeholder so they can see what they're
          // replacing.
          title: row?.title ?? "",
          body: row?.body ?? "",
          defaultTitle: template.title,
          defaultBody: template.body,
          variables: template.variables,
        };
      }),
    })),
    reachableDevices: tokens,
    logoUrl: settings.notificationLogoUrl,
  });
}

const settingSchema = z.object({
  event: z.string().min(1),
  // Any of these may be sent alone, so a single switch can be flipped
  // without the panel having to send everything.
  enabled: z.boolean().optional(),
  saveInApp: z.boolean().optional(),
  title: z.string().max(120).optional(),
  body: z.string().max(400).optional(),
});

// PATCH /api/admin/notifications/settings
export async function updateSetting(req: Request, res: Response) {
  const parsed = settingSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const event = parsed.data.event as NotificationEvent;
  const { enabled, saveInApp, title, body } = parsed.data;

  const setting = await prisma.notificationSetting.upsert({
    where: { event },
    create: {
      event,
      enabled: enabled ?? true,
      saveInApp: saveInApp ?? true,
      title: title ?? "",
      body: body ?? "",
    },
    update: {
      ...(enabled !== undefined ? { enabled } : {}),
      ...(saveInApp !== undefined ? { saveInApp } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(body !== undefined ? { body } : {}),
    },
  });

  return res.status(200).json({
    event,
    enabled: setting.enabled,
    saveInApp: setting.saveInApp,
    title: setting.title,
    body: setting.body,
  });
}

const sendSchema = z.object({
  title: z.string().min(1, "Enter a title").max(80),
  body: z.string().min(1, "Enter a message").max(300),
  url: z.string().url().or(z.literal("")).optional(),
  imageUrl: z.string().url().or(z.literal("")).optional(),
  /** Empty or absent sends to everyone. */
  userIds: z.array(z.string().uuid()).max(5000).optional(),
  /** Sends only to the admin's own devices. */
  testOnly: z.boolean().optional(),
  /** Whether it's also kept in the app's notification list. */
  saveInApp: z.boolean().optional(),
});

/**
 * POST /api/admin/notifications/send
 *
 * A custom push. Test sends go only to the admin's own devices and
 * ignore the event switches — the point of a test is to see the thing
 * before anyone else does.
 */
export async function sendCustom(req: Request, res: Response) {
  const parsed = sendSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const { title, body, url, imageUrl, userIds, testOnly, saveInApp = true } = parsed.data;

  const targets = testOnly
    ? [req.userId as string]
    : userIds && userIds.length > 0
      ? userIds
      : null;

  const result = await sendPush({
    event: "CUSTOM",
    title,
    body,
    url: url ?? "",
    imageUrl: imageUrl ?? "",
    userIds: targets,
    isTest: !!testOnly,
    force: !!testOnly,
  });

  // A test never leaves a record — it shouldn't clutter anyone's list,
  // including the admin's — and neither does a send the admin marked as
  // push-only.
  if (!testOnly && saveInApp) {
    const recipients = targets
      ? targets
      : (await prisma.user.findMany({ where: { isBanned: false }, select: { id: true } })).map(
          (u) => u.id
        );

    await prisma.notification.createMany({
      data: recipients.map((userId) => ({
        userId,
        type: "GENERIC" as const,
        title,
        message: body,
      })),
    });
  }

  return res.status(200).json(result);
}

// GET /api/admin/notifications/log
export async function getLog(_req: Request, res: Response) {
  const logs = await prisma.pushLog.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return res.status(200).json({ logs });
}

/**
 * GET /api/admin/notifications/recipients?q=
 *
 * Search for users to target. Kept small and name-only — the point is
 * picking two or three people, not browsing the whole database.
 */
export async function searchRecipients(req: Request, res: Response) {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (q.length < 2) return res.status(200).json({ users: [] });

  const users = await prisma.user.findMany({
    where: {
      isBanned: false,
      OR: [
        { name: { contains: q, mode: "insensitive" } },
        { username: { contains: q, mode: "insensitive" } },
        { email: { contains: q, mode: "insensitive" } },
        { phone: { contains: q } },
      ],
    },
    select: { id: true, name: true, username: true, pushEnabled: true },
    take: 20,
  });

  return res.status(200).json({ users });
}


/**
 * POST /api/admin/notifications/preview   body: { event, title, body }
 *
 * Renders wording with stand-in values, so an admin can see the result
 * before saving rather than discovering a broken placeholder from a
 * notification that has already gone out.
 */
export async function previewTemplate(req: Request, res: Response) {
  const event = String(req.body?.event ?? "") as NotificationEvent;
  const template = DEFAULT_TEMPLATES[event];

  if (!template) return res.status(400).json({ error: "Unknown event" });

  // Plausible-looking sample values, so the preview reads like a real
  // notification rather than a row of placeholder names.
  const samples: Record<string, string | number> = {
    fixture: "BAN vs IND",
    teamA: "Bangladesh",
    teamB: "India",
    minutes: 30,
    startTime: "12 Sep, 07:00 PM",
    contest: "Mega Contest",
    entryCost: 49,
    coins: 500,
    total: 1100,
    requested: 1000,
    bonus: 100,
    coupon: "BONUS10",
    agent: "Rahim Uddin",
    rank: 3,
    reason: "Not selected today",
    trackingId: "TRK-4821",
    name: "Karim Uddin",
    username: "karim99",
  };

  const title = String(req.body?.title ?? "").trim() || template.title;
  const body = String(req.body?.body ?? "").trim() || template.body;

  return res.status(200).json({
    title: render(title, samples),
    body: render(body, samples),
  });
}
