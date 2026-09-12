import prisma from "../config/prisma";
import { NotificationEvent } from "../generated/prisma/client";
import { resolveTemplate, TemplateVars } from "../utils/notificationTemplates";

/**
 * Push delivery, through Expo's service.
 *
 * Every push goes through here so that it is logged, throttled and
 * checked against the admin's switches. Nothing else in the codebase
 * should call Expo directly.
 */

const EXPO_ENDPOINT = "https://exp.host/--/api/v2/push/send";

/** Expo accepts at most 100 messages per request. */
const BATCH_SIZE = 100;

interface ExpoMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: "default";
  channelId?: string;
  /** Android only: the large image shown when the notification expands. */
  richContent?: { image: string };
}

interface ExpoTicket {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
}

export interface SendResult {
  recipients: number;
  delivered: number;
  failed: number;
  error: string;
}

export interface EventSetting {
  /** Sends a push. */
  enabled: boolean;
  /** Also kept in the app's notification list. */
  saveInApp: boolean;
  /** The admin's wording, blank when they haven't changed it. */
  title: string;
  body: string;
}

/** Both switches for an event. Unknown events default to on. */
export async function eventSetting(event: NotificationEvent): Promise<EventSetting> {
  const setting = await prisma.notificationSetting.findUnique({ where: { event } });
  return {
    enabled: setting?.enabled ?? true,
    saveInApp: setting?.saveInApp ?? true,
    title: setting?.title ?? "",
    body: setting?.body ?? "",
  };
}

export async function isEventEnabled(event: NotificationEvent): Promise<boolean> {
  return (await eventSetting(event)).enabled;
}

async function activeTokensFor(userIds: string[] | null): Promise<string[]> {
  const rows = await prisma.pushToken.findMany({
    where: {
      isActive: true,
      // A user who switched pushes off in the app is excluded here
      // rather than at send time, so their tokens never enter a batch.
      user: { pushEnabled: true, isBanned: false },
      ...(userIds ? { userId: { in: userIds } } : {}),
    },
    select: { token: true },
  });

  // The same device can appear under two accounts; sending twice would
  // show the notification twice.
  const tokens: string[] = rows.map((row: { token: string }) => row.token);
  return [...new Set<string>(tokens)];
}

/**
 * Removes tokens Expo says are dead.
 *
 * An uninstalled app keeps its row forever otherwise, and after a few
 * months most of a send would be aimed at devices that no longer exist.
 */
async function deactivateTokens(tokens: string[]) {
  if (tokens.length === 0) return;

  await prisma.pushToken.updateMany({
    where: { token: { in: tokens } },
    data: { isActive: false },
  });
}

interface SendOptions {
  event: NotificationEvent;
  /** Ignored when the event has a template; CUSTOM always uses these. */
  title?: string;
  body?: string;
  /** Values for the template's placeholders. */
  vars?: TemplateVars;
  url?: string;
  imageUrl?: string;
  /** Null sends to everyone. */
  userIds?: string[] | null;
  isTest?: boolean;
  /** Skips the enabled check — used by the admin's test send. */
  force?: boolean;
}

export async function sendPush(options: SendOptions): Promise<SendResult> {
  const {
    event,
    url = "",
    imageUrl = "",
    userIds = null,
    isTest = false,
    force = false,
    vars = {},
  } = options;

  const result: SendResult = { recipients: 0, delivered: 0, failed: 0, error: "" };

  const setting = await eventSetting(event);

  // CUSTOM has no template — the admin typed the words. Everything else
  // is rendered from the event's wording, so editing it in the panel
  // changes what actually goes out.
  const rendered =
    event === "CUSTOM"
      ? { title: options.title ?? "", body: options.body ?? "" }
      : resolveTemplate(event, { title: setting.title, body: setting.body }, vars);

  const title = rendered.title;
  const body = rendered.body;

  if (!force && !setting.enabled) {
    // Not an error: the admin turned this off on purpose. The in-app
    // notification is still written by the caller.
    return result;
  }

  const tokens = await activeTokensFor(userIds);
  result.recipients = tokens.length;

  if (tokens.length === 0) return result;

  const log = await prisma.pushLog.create({
    data: {
      event,
      title,
      body,
      url,
      imageUrl,
      targetUserId: userIds?.length === 1 ? userIds[0] : null,
      recipients: tokens.length,
      isTest,
    },
  });

  const dead: string[] = [];

  for (let start = 0; start < tokens.length; start += BATCH_SIZE) {
    const batch = tokens.slice(start, start + BATCH_SIZE);

    const messages: ExpoMessage[] = batch.map((token) => ({
      to: token,
      title,
      body,
      sound: "default",
      // Matches the channel the app creates; without it Android 8+
      // drops the notification into a silent default channel.
      channelId: "default",
      data: { url, event },
      ...(imageUrl ? { richContent: { image: imageUrl } } : {}),
    }));

    try {
      const response = await fetch(EXPO_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(messages),
      });

      if (!response.ok) {
        result.failed += batch.length;
        result.error = `Expo returned ${response.status}`;
        continue;
      }

      const payload = (await response.json()) as { data?: ExpoTicket[] };
      const tickets = payload.data ?? [];

      tickets.forEach((ticket, index) => {
        if (ticket.status === "ok") {
          result.delivered += 1;
          return;
        }

        result.failed += 1;

        if (ticket.details?.error === "DeviceNotRegistered") {
          dead.push(batch[index]);
        } else if (!result.error && ticket.message) {
          result.error = ticket.message;
        }
      });
    } catch (error) {
      result.failed += batch.length;
      result.error = (error as Error).message;
    }
  }

  await deactivateTokens(dead);

  await prisma.pushLog.update({
    where: { id: log.id },
    data: {
      delivered: result.delivered,
      failed: result.failed,
      status: result.failed > 0 && result.delivered === 0 ? "FAILED" : "SENT",
      error: result.error.slice(0, 400),
    },
  });

  return result;
}

/**
 * Writes the in-app notification and sends the push together.
 *
 * The record is always written; the push is subject to the admin's
 * switch. Failures are swallowed on purpose — a notification that
 * doesn't send must never break the action that triggered it, whether
 * that's paying a prize or banning an account.
 */
export async function notify(options: {
  userId: string;
  event: NotificationEvent;
  type?: "COIN_BONUS" | "COIN_FINE" | "BAN" | "GENERIC";
  title: string;
  message: string;
  coinAmount?: number;
  url?: string;
}): Promise<void> {
  const { userId, event, type = "GENERIC", title, message, coinAmount, url } = options;

  const setting = await eventSetting(event);

  if (setting.saveInApp) {
    try {
      await prisma.notification.create({
        data: { userId, type, title, message, coinAmount: coinAmount ?? null },
      });
    } catch (error) {
      console.error("Failed to write notification:", error);
    }
  }

  try {
    await sendPush({ event, title, body: message, url, userIds: [userId] });
  } catch (error) {
    console.error("Failed to send push:", error);
  }
}

/** Same, for many users at once — one push call rather than one each. */
export async function notifyMany(options: {
  userIds: string[];
  event: NotificationEvent;
  type?: "COIN_BONUS" | "COIN_FINE" | "BAN" | "GENERIC";
  title: string;
  message: string;
  url?: string;
}): Promise<void> {
  const { userIds, event, type = "GENERIC", title, message, url } = options;
  if (userIds.length === 0) return;

  const setting = await eventSetting(event);

  if (setting.saveInApp) {
    try {
      await prisma.notification.createMany({
        data: userIds.map((userId) => ({ userId, type, title, message })),
      });
    } catch (error) {
      console.error("Failed to write notifications:", error);
    }
  }

  try {
    await sendPush({ event, title, body: message, url, userIds });
  } catch (error) {
    console.error("Failed to send push:", error);
  }
}

/**
 * A push to everyone, with a matching in-app record for each user.
 *
 * Broadcasts write one notification row per user, which is a lot of rows
 * — but a push that leaves nothing behind is gone the moment it's
 * swiped away, and the user has no way to look it up again.
 */
export async function broadcast(options: {
  event: NotificationEvent;
  vars?: TemplateVars;
  url?: string;
}): Promise<SendResult> {
  const { event, url = "", vars = {} } = options;

  const setting = await eventSetting(event);

  // Skipped entirely when the event is off — no push and no rows, since
  // writing history for something nobody was told about is just noise.
  if (!setting.enabled) {
    return { recipients: 0, delivered: 0, failed: 0, error: "" };
  }

  // Rendered once here so the stored record and the push carry
  // identical wording.
  const { title, body } = resolveTemplate(
    event,
    { title: setting.title, body: setting.body },
    vars
  );

  const users = setting.saveInApp
    ? await prisma.user.findMany({ where: { isBanned: false }, select: { id: true } })
    : [];

  if (users.length > 0) {
    await prisma.notification.createMany({
      data: users.map((user) => ({
        userId: user.id,
        type: "GENERIC" as const,
        title,
        message: body,
      })),
    });
  }

  return sendPush({ event, url, vars });
}

/**
 * Whether an event's notification should be kept in the app.
 *
 * Exposed for the places that write their own record — inside a
 * transaction, or with fields `notify` doesn't carry — so they can
 * honour the same switch.
 */
export async function shouldSaveInApp(event: NotificationEvent): Promise<boolean> {
  return (await eventSetting(event)).saveInApp;
}
