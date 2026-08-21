import { Request, Response } from "express";
import prisma from "../config/prisma";

// GET /api/notifications  (auth required)
export async function listNotifications(req: Request, res: Response) {
  const userId = req.userId as string;

  const notifications = await prisma.notification.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  const unreadCount = await prisma.notification.count({ where: { userId, isRead: false } });

  return res.status(200).json({ notifications, unreadCount });
}

// PATCH /api/notifications/:id/read  (auth required)
export async function markNotificationRead(req: Request, res: Response) {
  const { id } = req.params as { id: string };
  const userId = req.userId as string;

  const notification = await prisma.notification.findUnique({ where: { id } });
  if (!notification || notification.userId !== userId) {
    return res.status(404).json({ error: "Notification not found" });
  }

  await prisma.notification.update({ where: { id }, data: { isRead: true } });

  return res.status(200).json({ message: "Marked as read" });
}

// GET /api/notifications/popups  (auth required)
//
// Unread coin bonus/fine notices that the app should surface as a modal
// the next time the user opens it, whenever that is. Reusing isRead is
// what makes this survive across sessions: the admin's bonus sits unread
// until the user has actually been shown it, so a bonus given while they
// were offline still greets them at next launch.
export async function listPopupNotifications(req: Request, res: Response) {
  const userId = req.userId as string;

  const notifications = await prisma.notification.findMany({
    where: {
      userId,
      isRead: false,
      type: { in: ["COIN_BONUS", "COIN_FINE"] },
    },
    // Oldest first — if several piled up, they're shown in the order
    // they happened.
    orderBy: { createdAt: "asc" },
    take: 10,
  });

  return res.status(200).json({ notifications });
}

// POST /api/notifications/popups/ack  (auth required)  body: { ids: string[] }
// Called once the app has actually displayed the modals, so a crash
// mid-display doesn't silently swallow a bonus notice.
export async function ackPopupNotifications(req: Request, res: Response) {
  const userId = req.userId as string;
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((id: unknown) => typeof id === "string") : [];

  if (ids.length === 0) {
    return res.status(400).json({ error: "ids is required" });
  }

  // Scoped to this user so an id from another account can't be marked.
  const result = await prisma.notification.updateMany({
    where: { id: { in: ids }, userId },
    data: { isRead: true },
  });

  return res.status(200).json({ acknowledged: result.count });
}
