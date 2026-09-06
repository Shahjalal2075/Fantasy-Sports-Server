import prisma from "../config/prisma";
import { broadcast } from "./pushService";

/**
 * Match reminders.
 *
 * Runs on a timer and looks for matches entering a window. Each reminder
 * is recorded once sent, because the loop runs every minute and without
 * that record the thirty-minute reminder would go out thirty times.
 */

/** How often the loop wakes up. */
const TICK_MS = 60 * 1000;

const REMINDERS = [
  { event: "MATCH_REMINDER_30" as const, minutesBefore: 30 },
  { event: "MATCH_REMINDER_15" as const, minutesBefore: 15 },
];

/**
 * How late a reminder may still fire.
 *
 * A tick can be delayed — a slow query, a restart — so the window is
 * wider than one minute. Beyond this the moment has passed and sending
 * "starts in 30 minutes" for a match already under way is worse than
 * sending nothing.
 */
const GRACE_MS = 4 * 60 * 1000;

async function alreadySent(matchId: string, event: string): Promise<boolean> {
  const existing = await prisma.pushLog.findFirst({
    where: {
      event: event as never,
      // The match id travels in the URL, which is what ties a log entry
      // back to its fixture.
      url: `match:${matchId}`,
      isTest: false,
    },
    select: { id: true },
  });

  return !!existing;
}

async function runTick(): Promise<void> {
  const now = Date.now();

  for (const reminder of REMINDERS) {
    const target = now + reminder.minutesBefore * 60 * 1000;

    const matches = await prisma.match.findMany({
      where: {
        status: "UPCOMING",
        startTime: {
          // Between the target moment and slightly before it, so a
          // delayed tick still catches the match.
          gte: new Date(target - GRACE_MS),
          lte: new Date(target),
        },
      },
      include: { teamA: true, teamB: true },
    });

    for (const match of matches) {
      if (await alreadySent(match.id, reminder.event)) continue;

      const fixture = `${match.teamA?.shortName ?? "?"} vs ${match.teamB?.shortName ?? "?"}`;

      await broadcast({
        event: reminder.event,
        title: `${fixture} starts in ${reminder.minutesBefore} minutes`,
        body: "Pick your team before the lineup locks.",
        url: `match:${match.id}`,
      });
    }
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startReminderLoop(): void {
  if (timer) return;

  timer = setInterval(() => {
    void runTick().catch((error) => console.error("Match reminder tick failed:", error));
  }, TICK_MS);

  timer.unref?.();
}

/**
 * POST /api/cron/match-reminders
 *
 * Exposed so an external scheduler can drive this if the process is ever
 * put somewhere that sleeps. Harmless to call alongside the timer — the
 * already-sent check makes a double run a no-op.
 */
export async function runRemindersNow(): Promise<void> {
  await runTick();
}
