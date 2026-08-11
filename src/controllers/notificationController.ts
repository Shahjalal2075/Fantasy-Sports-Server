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
