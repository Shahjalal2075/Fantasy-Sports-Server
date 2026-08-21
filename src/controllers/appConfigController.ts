import { Request, Response } from "express";
import prisma from "../config/prisma";
import { recordHeartbeat } from "../services/presenceService";
import { getActiveBanners } from "./bannerController";

// Banners are read on the same hot path and change just as rarely, so
// they get the same treatment.
const BANNERS_CACHE_MS = 60 * 1000;
let bannersCache: { value: Awaited<ReturnType<typeof getActiveBanners>>; expiresAt: number } | null =
  null;

async function loadBanners() {
  if (bannersCache && Date.now() < bannersCache.expiresAt) return bannersCache.value;
  const value = await getActiveBanners();
  bannersCache = { value, expiresAt: Date.now() + BANNERS_CACHE_MS };
  return value;
}

export function invalidateBannersCache() {
  bannersCache = null;
}

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

// Settings change maybe a few times a week, but /api/app-config is polled
// by every open app every five minutes. Reading through a short cache
// turns that from a database round-trip per poll into roughly one per
// minute for the whole userbase.
//
// The old implementation used upsert, which issued a *write* on every
// single read — the worst case for a serverless database that bills by
// compute time.
const SETTINGS_CACHE_MS = 60 * 1000;

let settingsCache: { value: Awaited<ReturnType<typeof fetchSettings>>; expiresAt: number } | null =
  null;

async function fetchSettings() {
  // Single-row table; create it on first read so a fresh deploy doesn't
  // need the seed to have run before the app can boot.
  const existing = await prisma.appSettings.findUnique({ where: { id: 1 } });
  if (existing) return existing;
  return prisma.appSettings.create({ data: { id: 1 } });
}

async function loadSettings() {
  if (settingsCache && Date.now() < settingsCache.expiresAt) {
    return settingsCache.value;
  }

  const value = await fetchSettings();
  settingsCache = { value, expiresAt: Date.now() + SETTINGS_CACHE_MS };
  return value;
}

/**
 * Drops the cache so an admin's change is visible immediately rather
 * than up to a minute later — important for maintenance mode, where the
 * whole point is to take the app down *now*.
 */
export function invalidateSettingsCache() {
  settingsCache = null;
}

/**
 * GET /api/app-config?version=1.2.0&platform=android
 *
 * Deliberately public — the app calls it before login, because a device
 * blocked by maintenance or a forced update must never reach the login
 * screen in the first place.
 */
export async function getAppConfig(req: Request, res: Response) {
  const [settings, banners] = await Promise.all([loadSettings(), loadBanners()]);
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

      // Ordered slider content. Each entry may carry a linkUrl; blank
      // means the banner isn't tappable.
      banners,

      dailyBonusAmount: settings.dailyBonusAmount,

      // Shown when someone taps the (non-functional) Deposit button.
      deposit: {
        message: settings.depositMessage,
        buttonText: settings.depositButtonText,
        buttonLogo: settings.depositButtonLogo,
        buttonUrl: settings.depositButtonUrl,
      },

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

/**
 * GET /api/app-config/legal
 *
 * Privacy policy and terms, written by an admin. Deliberately a separate
 * endpoint from /api/app-config: that one is polled every few minutes by
 * every open app, and these documents are far too long to ride along.
 */
export async function getLegalDocuments(_req: Request, res: Response) {
  const settings = await loadSettings();

  return res.status(200).json({
    legal: {
      privacyPolicy: settings.privacyPolicy,
      termsAndConditions: settings.termsAndConditions,
      updatedAt: settings.legalUpdatedAt,
    },
  });
}
