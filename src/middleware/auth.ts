import { Request, Response, NextFunction } from "express";
import { verifyToken } from "../utils/jwt";
import prisma from "../config/prisma";

// Extend Express Request so downstream handlers can read req.userId
declare global {
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Authorization token missing" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const payload = verifyToken(token);
    const user = await prisma.user.findUnique({ where: { id: payload.userId }, select: { isBanned: true, bannedReason: true } });
    if (!user) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }
    if (user.isBanned) {
      return res.status(403).json({ error: user.bannedReason || "This account has been banned" });
    }
    req.userId = payload.userId;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

/**
 * Attaches req.userId when a valid token is present, but never rejects.
 * Used by endpoints that serve logged-out visitors too (app config,
 * heartbeat) where knowing who the user is is a bonus, not a gate.
 */
export async function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) return next();

  try {
    const payload = verifyToken(authHeader.split(" ")[1]);
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: { isBanned: true },
    });
    // A banned user still counts as traffic; just don't credit them.
    if (user && !user.isBanned) req.userId = payload.userId;
  } catch {
    // An expired or malformed token is simply treated as logged out.
  }
  next();
}

// Must run AFTER requireAuth (relies on req.userId being set already).
// Blocks the request unless the logged-in user has isAdmin = true.
export async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.userId) {
    return res.status(401).json({ error: "Authorization token missing" });
  }

  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    select: { isAdmin: true },
  });

  if (!user || !user.isAdmin) {
    return res.status(403).json({ error: "Admin access required" });
  }

  next();
}
