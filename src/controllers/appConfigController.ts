import { Request, Response } from "express";
import prisma from "../config/prisma";
import { recordHeartbeat } from "../services/presenceService";

/**
 * Compares dotted numeric versions ("1.4.2" vs "1.10.0").
 * Returns <0, 0, >0 like a sort comparator. A plain string compare would
 * get 1.10.0 < 1.4.2 wrong, hence the part-by-part walk.
 */
export function compareVersions(a: string, b: string): number {
  const partsA = a.split(".").map((n) => parseInt(n, 10) || 0);
  const partsB = b.split(".").map((n) => parseInt(n, 10) || 0);
  const length = Math.max(partsA.length, partsB.length);

  for (let i = 0; i < length; i += 1) {
    const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function loadSettings() {
  // Single-row table; create it on first read so a fresh deploy doesn't
  // need the seed to have run before the app can boot.
  return prisma.appSettings.upsert({
    where: { id: 1 },
    create: { id: 1 },
    update: {},
  });
}

/**
 * GET /api/app-config?version=1.2.0&platform=android
 *
 * Deliberately public — the app calls it before login, because a device
 * blocked by maintenance or a forced update must never reach the login
 * screen in the first place.
 */
export async function getAppConfig(req: Request, res: Response) {
  const settings = await loadSettings();
  const clientVersion = typeof req.query.version === "string" ? req.query.version : "0.0.0";

  const mustUpdate = compareVersions(clientVersion, settings.minSupportedVersion) < 0;
  // Don't nag about an optional update while already forcing a hard one.
  const updateAvailable = !mustUpdate && compareVersions(clientVersion, settings.latestAppVersion) < 0;

  return res.status(200).json({
    config: {
      maintenanceMode: settings.maintenanceMode,
      maintenanceMessage: settings.maintenanceMessage,

      mustUpdate,
      updateAvailable,
      latestAppVersion: settings.latestAppVersion,
      minSupportedVersion: settings.minSupportedVersion,
      updateUrl: settings.updateUrl,
      updateMessage: settings.updateMessage,

      hasBanner: settings.hasBanner,
      bannerImageUrl: settings.hasBanner ? settings.bannerImageUrl : "",

      dailyBonusAmount: settings.dailyBonusAmount,

      support: {
        email: settings.supportEmail,
        phone: settings.supportPhone,
        whatsapp: settings.supportWhatsapp,
        facebook: settings.supportFacebook,
        hours: settings.supportHours,
      },
    },
  });
}

/**
 * POST /api/app-config/heartbeat
 *
 * Also public: logged-out visitors still count as traffic. When a token
 * happens to be present, optionalAuth attaches the userId so the admin
 * list can name who's online.
 */
export async function postHeartbeat(req: Request, res: Response) {
  const { deviceId, platform, appVersion } = req.body ?? {};

  if (!deviceId || typeof deviceId !== "string") {
    return res.status(400).json({ error: "deviceId is required" });
  }

  const { liveCount } = await recordHeartbeat({
    deviceId,
    userId: req.userId ?? null,
    platform: typeof platform === "string" ? platform : "",
    appVersion: typeof appVersion === "string" ? appVersion : "",
  });

  return res.status(200).json({ liveCount });
}
