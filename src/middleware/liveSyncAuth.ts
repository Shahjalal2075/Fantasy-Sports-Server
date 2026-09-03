import { NextFunction, Request, Response } from "express";
import crypto from "node:crypto";

/**
 * Authenticates the separate live-score service.
 *
 * A shared key, not an admin login: this is one server talking to
 * another, with no user involved. The key belongs in the live service's
 * environment and in this one's — nowhere else, and never in a browser
 * bundle.
 */
export function requireLiveSyncKey(req: Request, res: Response, next: NextFunction) {
  const configured = process.env.LIVE_SYNC_KEY ?? "";

  if (!configured) {
    return res.status(503).json({
      error: "Live sync is not configured on this server (LIVE_SYNC_KEY is unset).",
    });
  }

  const provided = String(req.header("x-live-sync-key") ?? "");

  // Constant-time comparison: a plain !== leaks the key one character at
  // a time to anyone willing to measure the response.
  const a = Buffer.from(provided);
  const b = Buffer.from(configured);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);

  if (!ok) {
    return res.status(401).json({ error: "Invalid live sync key" });
  }

  return next();
}
