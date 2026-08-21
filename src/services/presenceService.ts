import prisma from "../config/prisma";

// A device counts as "online" if it has pinged within this window. The
// app heartbeats every 60s, so two minutes tolerates one dropped ping
// without a user flickering out of the count.
export const LIVE_WINDOW_MS = 2 * 60 * 1000;

// Sessions older than this are pruned — they're finished visits, and the
// hourly VisitorStat rollup already preserves the history.
const SESSION_RETENTION_MS = 24 * 60 * 60 * 1000;

function hourBucket(date: Date): Date {
  const bucket = new Date(date);
  bucket.setUTCMinutes(0, 0, 0);
  return bucket;
}

/**
 * Records a heartbeat from one device and returns the current live count.
 *
 * Everything is driven by this one call rather than a scheduled job: the
 * upsert keeps presence fresh, and the same request folds the result into
 * the hour's rollup so the admin graph fills in by itself.
 */
export async function recordHeartbeat(input: {
  deviceId: string;
  userId?: string | null;
  platform?: string;
  appVersion?: string;
}): Promise<{ liveCount: number }> {
  const now = new Date();

  await prisma.activeSession.upsert({
    where: { deviceId: input.deviceId },
    create: {
      deviceId: input.deviceId,
      userId: input.userId ?? null,
      platform: input.platform ?? "",
      appVersion: input.appVersion ?? "",
      lastSeenAt: now,
    },
    update: {
      userId: input.userId ?? null,
      platform: input.platform ?? "",
      appVersion: input.appVersion ?? "",
      lastSeenAt: now,
    },
  });

  const liveCount = await getLiveCount(now);
  const bucketStart = hourBucket(now);

  // Distinct devices seen this hour, counted from the sessions table
  // rather than kept as a running total, so a device that pings 60 times
  // still only counts once.
  const uniqueDevices = await prisma.activeSession.count({
    where: { lastSeenAt: { gte: bucketStart } },
  });

  const existing = await prisma.visitorStat.findUnique({ where: { bucketStart } });

  if (!existing) {
    await prisma.visitorStat.create({
      data: { bucketStart, peakConcurrent: liveCount, uniqueDevices },
    });
  } else {
    await prisma.visitorStat.update({
      where: { bucketStart },
      data: {
        // Peak only ever climbs within its hour.
        peakConcurrent: Math.max(existing.peakConcurrent, liveCount),
        uniqueDevices: Math.max(existing.uniqueDevices, uniqueDevices),
      },
    });
  }

  // Opportunistic cleanup — cheap, indexed, and keeps the table bounded
  // without needing a separate maintenance task.
  if (Math.random() < 0.02) {
    await prisma.activeSession.deleteMany({
      where: { lastSeenAt: { lt: new Date(now.getTime() - SESSION_RETENTION_MS) } },
    });
  }

  return { liveCount };
}

export async function getLiveCount(now: Date = new Date()): Promise<number> {
  return prisma.activeSession.count({
    where: { lastSeenAt: { gte: new Date(now.getTime() - LIVE_WINDOW_MS) } },
  });
}

/** The devices currently online, for the admin panel's detail list. */
export async function getLiveSessions(now: Date = new Date()) {
  return prisma.activeSession.findMany({
    where: { lastSeenAt: { gte: new Date(now.getTime() - LIVE_WINDOW_MS) } },
    include: { user: { select: { id: true, name: true, username: true } } },
    orderBy: { lastSeenAt: "desc" },
    take: 200,
  });
}

/**
 * Hourly history for the traffic graph. Hours with no traffic are filled
 * in as zeros so the chart has an even x-axis instead of gaps.
 */
export async function getVisitorHistory(hours: number) {
  const now = new Date();
  const since = hourBucket(new Date(now.getTime() - hours * 60 * 60 * 1000));

  const rows = await prisma.visitorStat.findMany({
    where: { bucketStart: { gte: since } },
    orderBy: { bucketStart: "asc" },
  });

  const byBucket = new Map(rows.map((r) => [r.bucketStart.toISOString(), r]));
  const series: { bucketStart: string; peakConcurrent: number; uniqueDevices: number }[] = [];

  for (let i = 0; i <= hours; i += 1) {
    const bucket = new Date(since.getTime() + i * 60 * 60 * 1000);
    const key = bucket.toISOString();
    const row = byBucket.get(key);
    series.push({
      bucketStart: key,
      peakConcurrent: row?.peakConcurrent ?? 0,
      uniqueDevices: row?.uniqueDevices ?? 0,
    });
  }

  return series;
}
