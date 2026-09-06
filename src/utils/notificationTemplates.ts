import { NotificationEvent } from "../generated/prisma";

/**
 * The wording for every automatic notification.
 *
 * Kept in one place so the admin panel shows exactly what will be sent.
 * With the text living at each call site instead, the panel could only
 * ever guess, and the two would drift apart the first time one changed.
 *
 * Placeholders are written as {name} and filled at send time. A
 * placeholder the event doesn't provide is left as-is rather than
 * blanked, so a typo in the admin panel is visible instead of silently
 * producing "starts in  minutes".
 */

export interface Template {
  title: string;
  body: string;
  /** What can be used in this event's text. */
  variables: string[];
}

export const DEFAULT_TEMPLATES: Record<string, Template> = {
  MATCH_REMINDER_30: {
    title: "{fixture} starts in {minutes} minutes",
    body: "Pick your team before the lineup locks.",
    variables: ["fixture", "minutes", "teamA", "teamB"],
  },
  MATCH_REMINDER_15: {
    title: "{fixture} starts in {minutes} minutes",
    body: "Last chance to build your team.",
    variables: ["fixture", "minutes", "teamA", "teamB"],
  },
  MATCH_TIME_CHANGED: {
    title: "{fixture} has been rescheduled",
    body: "New start time: {startTime}",
    variables: ["fixture", "startTime", "teamA", "teamB"],
  },
  NEW_CONTEST: {
    title: "New contest open",
    body: "{contest} — {fixture}",
    variables: ["contest", "fixture", "entryCost", "teamA", "teamB"],
  },

  CONTEST_PRIZE: {
    title: "You won {coins} coins!",
    body: "Rank #{rank} in {contest}.",
    variables: ["coins", "rank", "contest"],
  },
  ADMIN_BONUS: {
    title: "You received {coins} bonus coins",
    body: "{reason}",
    variables: ["coins", "reason"],
  },
  ADMIN_FINE: {
    title: "You were fined {coins} coins",
    body: "{reason}",
    variables: ["coins", "reason"],
  },
  REFERRAL_BONUS: {
    title: "Referral bonus",
    body: "You received {coins} coins for signing up with a referral code.",
    variables: ["coins"],
  },
  REFERRAL_REWARD: {
    title: "Referral reward",
    body: "{name} joined their first paid contest. You earned {coins} coins!",
    variables: ["name", "username", "coins"],
  },

  COIN_REQUEST_APPROVED: {
    title: "{total} coins added",
    body: "Your coin request was approved.",
    variables: ["total", "requested", "bonus", "coupon", "agent"],
  },
  COIN_REQUEST_DECLINED: {
    title: "Your coin request wasn't approved",
    body: "{reason}",
    variables: ["reason", "requested", "agent"],
  },
  GIFT_APPROVED: {
    title: "Your gift is on the way!",
    body: "Approved. Tracking ID: {trackingId}",
    variables: ["trackingId", "coins"],
  },
  GIFT_CANCELLED: {
    title: "Coins returned",
    body: "{coins} coins are back in your balance. {reason}",
    variables: ["coins", "reason"],
  },
  GIFT_EXPIRED: {
    title: "Coins returned",
    body: "Your gift request wasn't selected, so {coins} coins are back in your balance.",
    variables: ["coins"],
  },

  ACCOUNT_VERIFIED: {
    title: "You're verified",
    body: "A blue tick now appears next to your name.",
    variables: [],
  },
  VERIFICATION_REMOVED: {
    title: "Verification removed",
    body: "Your account verification has been removed.",
    variables: [],
  },
  PASSWORD_RESET: {
    title: "Your password was reset",
    body: "An administrator set a new password. If you didn't request this, contact support.",
    variables: [],
  },
  ACCOUNT_BANNED: {
    title: "Your account has been banned",
    body: "{reason}",
    variables: ["reason"],
  },

  CUSTOM: {
    title: "",
    body: "",
    variables: [],
  },
};

export type TemplateVars = Record<string, string | number>;

/** Replaces {name} with its value, leaving unknown names untouched. */
export function render(text: string, vars: TemplateVars): string {
  return text.replace(/\{(\w+)\}/g, (whole, key: string) => {
    const value = vars[key];
    if (value === undefined || value === null) return whole;
    return typeof value === "number" ? value.toLocaleString() : String(value);
  });
}

/**
 * The wording to use, preferring the admin's version.
 *
 * A blank field falls back to the default rather than sending an empty
 * notification — clearing a box in the panel reads as "use the standard
 * text", not "send nothing".
 */
export function resolveTemplate(
  event: NotificationEvent,
  custom: { title: string; body: string } | null,
  vars: TemplateVars
): { title: string; body: string } {
  const fallback = DEFAULT_TEMPLATES[event] ?? { title: "", body: "", variables: [] };

  return {
    title: render(custom?.title?.trim() || fallback.title, vars),
    body: render(custom?.body?.trim() || fallback.body, vars),
  };
}
