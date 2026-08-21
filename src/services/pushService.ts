import { Expo, ExpoPushMessage, ExpoPushTicket } from "expo-server-sdk";
import prisma from "../config/prisma";

// No access token needed for the public Expo push service.
const expo = new Expo();

export interface PushPayload {
  title: string;
  body: string;
  /** Screen name the app should open when tapped. */
  linkTo?: string;
  data?: Record<string, unknown>;
}

async function loadSettings() {
  return prisma.appSettings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
}

/**
 * Whether a given automatic push is switched on.
 *
 * Every automatic push checks this, so an admin can silence one kind
 * (say, coin bonuses) without turning the whole system off. The master
 * `pushEnabled` switch overrides all of them.
 */
export async function isPushEnabled(
  event: "coinBonus" | "giftUpdate" | "prizeDistributed" | "matchLock"
): Promise<boolean> {
  const settings = await loadSettings();
  if (!settings.pushEnabled) return false;

  switch (event) {
    case "coinBonus":
      return settings.pushOnCoinBonus;
    case "giftUpdate":
      return settings.pushOnGiftUpdate;
    case "prizeDistributed":
      return settings.pushOnPrizeDistributed;
    case "matchLock":
      return settings.pushOnMatchLock;
  }
}

/**
 * Sends to a list of Expo tokens, cleaning up as it goes.
 *
 * Expo returns a ticket per message; a "DeviceNotRegistered" error means
 * the app was uninstalled or the token rotated, so that row is
 * deactivated rather than retried forever.
 */
async function sendToTokens(tokens: string[], payload: PushPayload) {
  const valid = tokens.filter((token) => Expo.isExpoPushToken(token));
  if (valid.length === 0) return { sent: 0, failed: 0 };

  const messages: ExpoPushMessage[] = valid.map((to) => ({
    to,
    sound: "default",
    title: payload.title,
    body: payload.body,
    data: { linkTo: payload.linkTo ?? "", ...(payload.data ?? {}) },
    // Android-specific: shows under a named channel the app creates.
    channelId: "default",
  }));

  // chunkPushNotifications respects Expo's per-request size limit and
  // the ~600/sec throughput cap.
  const chunks = expo.chunkPushNotifications(messages);
  const tickets: ExpoPushTicket[] = [];

  for (const chunk of chunks) {
    try {
      const result = await expo.sendPushNotificationsAsync(chunk);
      tickets.push(...result);
    } catch (err) {
      // A whole chunk failing is usually a network blip; the rest still
      // go out rather than aborting the campaign.
      console.error("Expo push chunk failed:", err);
    }
  }

  let sent = 0;
  let failed = 0;
  const deadTokens: string[] = [];

  tickets.forEach((ticket, index) => {
    if (ticket.status === "ok") {
      sent += 1;
      return;
    }
    failed += 1;
    if (ticket.details?.error === "DeviceNotRegistered") {
      deadTokens.push(valid[index]);
    }
  });

  if (deadTokens.length > 0) {
    await prisma.pushToken.updateMany({
      where: { token: { in: deadTokens } },
      data: { isActive: false },
    });
  }

  return { sent, failed };
}

/** Push to one user, across every device they have registered. */
export async function pushToUser(userId: string, payload: PushPayload) {
  const settings = await loadSettings();
  if (!settings.pushEnabled) return { sent: 0, failed: 0 };

  const rows = await prisma.pushToken.findMany({
    where: { userId, isActive: true },
    select: { token: true },
  });

  return sendToTokens(rows.map((r) => r.token), payload);
}

/** Push to every registered device. Used by admin broadcasts. */
export async function pushToEveryone(payload: PushPayload) {
  const settings = await loadSettings();
  if (!settings.pushEnabled) return { sent: 0, failed: 0 };

  const rows = await prisma.pushToken.findMany({
    where: { isActive: true },
    select: { token: true },
  });

  return sendToTokens(rows.map((r) => r.token), payload);
}

/** Push to a specific set of users — used by the match lock reminder. */
export async function pushToUsers(userIds: string[], payload: PushPayload) {
  if (userIds.length === 0) return { sent: 0, failed: 0 };

  const settings = await loadSettings();
  if (!settings.pushEnabled) return { sent: 0, failed: 0 };

  const rows = await prisma.pushToken.findMany({
    where: { userId: { in: userIds }, isActive: true },
    select: { token: true },
  });

  return sendToTokens(rows.map((r) => r.token), payload);
}

/**
 * Fires any campaign whose scheduled time has arrived, and any match
 * lock reminder that's now due.
 *
 * Called opportunistically from the heartbeat endpoint rather than a
 * cron job — this project has no scheduler, and the heartbeat runs every
 * few minutes from every open app, which is frequent enough for a
 * reminder measured in tens of minutes.
 */
export async function runDueNotifications(): Promise<void> {
  await Promise.all([runDueCampaigns(), runDueMatchReminders()]);
}

async function runDueCampaigns() {
  const due = await prisma.pushCampaign.findMany({
    where: { status: "SCHEDULED", scheduledFor: { lte: new Date() } },
    take: 5,
  });

  for (const campaign of due) {
    // Claim it first: two servers (or two overlapping heartbeats) must
    // not send the same campaign twice.
    const claimed = await prisma.pushCampaign.updateMany({
      where: { id: campaign.id, status: "SCHEDULED" },
      data: { status: "SENT", sentAt: new Date() },
    });
    if (claimed.count === 0) continue;

    try {
      const result = await pushToEveryone({
        title: campaign.title,
        body: campaign.body,
        linkTo: campaign.linkTo,
      });
      await prisma.pushCampaign.update({
        where: { id: campaign.id },
        data: { sentCount: result.sent, failedCount: result.failed },
      });
    } catch (err) {
      await prisma.pushCampaign.update({
        where: { id: campaign.id },
        data: { status: "FAILED", error: String(err).slice(0, 400) },
      });
    }
  }
}

async function runDueMatchReminders() {
  if (!(await isPushEnabled("matchLock"))) return;

  const settings = await loadSettings();
  const windowEnd = new Date(Date.now() + settings.matchLockReminderMinutes * 60 * 1000);

  const matches = await prisma.match.findMany({
    where: {
      status: "UPCOMING",
      lockReminderSentAt: null,
      // Inside the reminder window but not yet locked.
      lockTime: { lte: windowEnd, gt: new Date() },
    },
    include: { teamA: true, teamB: true },
    take: 5,
  });

  for (const match of matches) {
    const claimed = await prisma.match.updateMany({
      where: { id: match.id, lockReminderSentAt: null },
      data: { lockReminderSentAt: new Date() },
    });
    if (claimed.count === 0) continue;

    const minutes = Math.max(
      1,
      Math.round((match.lockTime.getTime() - Date.now()) / (60 * 1000))
    );

    await pushToEveryone({
      title: `${match.teamA?.shortName ?? "Match"} vs ${match.teamB?.shortName ?? ""} starts soon`,
      body: `Only ${minutes} minutes left to build your team and join a contest.`,
      linkTo: "Home",
    });
  }
}
