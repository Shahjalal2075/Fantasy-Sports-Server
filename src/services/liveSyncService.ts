import prisma from "../config/prisma";
import { normaliseName, randomMatchCode, randomPlayerCode } from "../utils/liveCodes";
import { syncMatchPlayerAggregate } from "./pointsService";

/**
 * The fantasy side of the bridge to the separate live-score service.
 *
 * The two systems share nothing but an HTTP endpoint and a key. This
 * file owns the pairing records and the merge rules for an incoming
 * scorecard.
 */

// ---------- Pairing ----------

/** Creates the pairing code for a match, or returns the existing one. */
export async function ensureMatchCode(matchId: string) {
  const existing = await prisma.matchLiveLink.findUnique({ where: { matchId } });
  if (existing) return existing;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const code = randomMatchCode();
    const clash = await prisma.matchLiveLink.findUnique({ where: { code } });
    if (clash) continue;

    return prisma.matchLiveLink.create({ data: { matchId, code } });
  }

  // Ten collisions in a 387-million space means something is wrong, but
  // appending the clock guarantees a usable code rather than an error.
  return prisma.matchLiveLink.create({
    data: { matchId, code: `${randomMatchCode()}${Date.now().toString(36).slice(-2).toUpperCase()}` },
  });
}

/** Breaks the pairing. Player codes are kept so reconnecting is instant. */
export async function disconnectMatch(matchId: string) {
  await prisma.matchLiveLink.update({
    where: { matchId },
    data: { liveMatchId: null, liveLabel: "", connectedAt: null },
  });

  // Nobody is connected once the match isn't. The codes stay, so
  // reconnecting confirms them all again in one step.
  await prisma.playerLiveLink.updateMany({
    where: { matchPlayer: { matchId } },
    data: { isActive: false },
  });
}

export interface IncomingPlayer {
  /** The live service's name for the player. */
  name: string;
  /** Set when the live panel is reconnecting a player it already paired. */
  code?: string;
}

export interface ConnectResult {
  matchId: string;
  matchName: string;
  connected: { code: string; liveName: string; fantasyName: string; automatic: boolean }[];
  unmatched: string[];
  /** Fantasy players with nobody on the live side. */
  missing: { matchPlayerId: string; name: string; code: string }[];
}

/**
 * Pairs a match and reconciles its squad against the live one.
 *
 * Called on first connect and again on every refetch. Existing codes are
 * never regenerated: a player already paired stays paired even if the
 * live squad is cut from thirty names to the eleven who took the field.
 * Players the live side no longer reports are marked inactive rather
 * than deleted, so re-selection reconnects them without a new code.
 */
export async function connectAndReconcile(input: {
  code: string;
  liveMatchId: string;
  liveLabel?: string;
  players: IncomingPlayer[];
}): Promise<ConnectResult | { error: string }> {
  const link = await prisma.matchLiveLink.findUnique({
    where: { code: input.code.trim().toUpperCase() },
    include: { match: { include: { teamA: true, teamB: true } } },
  });

  if (!link) return { error: "That pairing code doesn't match any fixture." };

  await prisma.matchLiveLink.update({
    where: { id: link.id },
    data: {
      liveMatchId: input.liveMatchId,
      liveLabel: input.liveLabel ?? "",
      connectedAt: new Date(),
    },
  });

  const matchPlayers = await prisma.matchPlayer.findMany({
    where: { matchId: link.matchId },
    include: { player: true, liveLink: true },
  });

  // Everything currently paired, indexed both ways.
  const byCode = new Map<string, (typeof matchPlayers)[number]>();
  const byNormalisedName = new Map<string, (typeof matchPlayers)[number]>();

  for (const mp of matchPlayers) {
    if (mp.liveLink) byCode.set(mp.liveLink.code, mp);
    const key = normaliseName(mp.player.name);
    // First one wins; a duplicate name is exactly the case an admin
    // resolves by editing the code.
    if (!byNormalisedName.has(key)) byNormalisedName.set(key, mp);
  }

  const usedCodes = new Set(matchPlayers.map((mp) => mp.liveLink?.code).filter(Boolean) as string[]);
  const seenMatchPlayerIds = new Set<string>();

  const connected: ConnectResult["connected"] = [];
  const unmatched: string[] = [];

  function nextCode(): string {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const code = randomPlayerCode();
      if (!usedCodes.has(code)) {
        usedCodes.add(code);
        return code;
      }
    }
    return `${randomPlayerCode()}${usedCodes.size}`;
  }

  for (const incoming of input.players) {
    const name = incoming.name?.trim();
    if (!name) continue;

    // A code sent back by the live panel wins over the name: that's the
    // whole point of codes surviving a rename or a duplicate.
    let target = incoming.code ? byCode.get(incoming.code.trim().toUpperCase()) : undefined;
    let automatic = true;

    if (target) {
      automatic = target.liveLink?.matchedAutomatically ?? true;
    } else {
      target = byNormalisedName.get(normaliseName(name));
    }

    if (!target || seenMatchPlayerIds.has(target.id)) {
      unmatched.push(name);
      continue;
    }

    seenMatchPlayerIds.add(target.id);

    const code = target.liveLink?.code ?? nextCode();

    await prisma.playerLiveLink.upsert({
      where: { matchPlayerId: target.id },
      create: {
        matchPlayerId: target.id,
        code,
        liveName: name,
        isActive: true,
        matchedAutomatically: automatic,
      },
      // Confirmed by the live service. matchedAutomatically is left as
      // it was: a hand-set pairing stays flagged as one.
      update: { liveName: name, isActive: true },
    });

    connected.push({
      code,
      liveName: name,
      fantasyName: target.player.name,
      automatic,
    });
  }

  // Anyone the live side didn't mention this time is parked, not erased.
  const droppedIds = matchPlayers
    .filter((mp) => mp.liveLink && !seenMatchPlayerIds.has(mp.id))
    .map((mp) => mp.id);

  if (droppedIds.length > 0) {
    await prisma.playerLiveLink.updateMany({
      where: { matchPlayerId: { in: droppedIds } },
      data: { isActive: false },
    });
  }

  const missing = matchPlayers
    .filter((mp) => !seenMatchPlayerIds.has(mp.id))
    .map((mp) => ({
      matchPlayerId: mp.id,
      name: mp.player.name,
      code: mp.liveLink?.code ?? "",
    }));

  return {
    matchId: link.matchId,
    matchName: `${link.match.teamA?.name ?? "?"} vs ${link.match.teamB?.name ?? "?"}`,
    connected,
    unmatched,
    missing,
  };
}

// ---------- Incoming scorecard ----------

/**
 * Figures for one player in one innings.
 *
 * Every field is optional. Anything absent is left exactly as it stands
 * in the database — that's what protects the values an admin enters by
 * hand, which the live feed has no way to supply.
 */
export interface IncomingPlayerStats {
  code: string;
  inningsNumber: number;

  runs?: number;
  ballsFaced?: number;
  fours?: number;
  sixes?: number;
  isOut?: boolean;

  ballsBowled?: number;
  maidens?: number;
  runsConceded?: number;
  wickets?: number;

  catches?: number;
  stumpings?: number;
  runOutsDirect?: number;
  runOutsIndirect?: number;
}

export interface IncomingInnings {
  inningsNumber: number;
  /** Live-side team name; resolved against the fixture's two teams. */
  teamName: string;
  runs: number;
  wickets: number;
  /** Cricket notation: 19.4 means 19 overs and 4 balls. */
  overs: number;
}

/** "19.4" -> 118 balls. */
function oversToBalls(overs: number): number {
  const whole = Math.floor(overs);
  const fraction = Number((overs - whole).toFixed(2));
  return whole * 6 + Math.min(Math.round(fraction * 10), 5);
}

export interface ApplyResult {
  matchId: string;
  playersUpdated: number;
  inningsUpdated: number;
  skipped: string[];
}

/**
 * Merges a pushed scorecard into the fantasy match.
 *
 * Deliberately a merge and not a replace. Dot balls and the bowled/LBW
 * split have no equivalent in the live feed, and an admin enters them by
 * hand — overwriting them on every push would destroy that work. The
 * playing XI is likewise left alone: the live side reports who played,
 * but selection stays an admin decision.
 */
export async function applyLiveScore(input: {
  code: string;
  innings: IncomingInnings[];
  players: IncomingPlayerStats[];
}): Promise<ApplyResult | { error: string }> {
  const link = await prisma.matchLiveLink.findUnique({
    where: { code: input.code.trim().toUpperCase() },
    include: { match: { include: { teamA: true, teamB: true } } },
  });

  if (!link) return { error: "That pairing code doesn't match any fixture." };
  if (!link.liveMatchId) return { error: "This fixture isn't connected to the live service." };

  const matchPlayers = await prisma.matchPlayer.findMany({
    where: { matchId: link.matchId },
    include: { liveLink: true, player: true },
  });

  const byCode = new Map(
    matchPlayers.filter((mp) => mp.liveLink).map((mp) => [mp.liveLink!.code, mp])
  );

  const skipped: string[] = [];
  const touched = new Set<string>();
  let playersUpdated = 0;

  for (const incoming of input.players) {
    const target = byCode.get(incoming.code?.trim().toUpperCase() ?? "");
    if (!target) {
      skipped.push(incoming.code);
      continue;
    }

    // Only the fields actually sent are written; the rest keep their
    // current values.
    const data: Record<string, number | boolean> = {};
    const copy = <K extends keyof IncomingPlayerStats>(key: K) => {
      const value = incoming[key];
      if (value !== undefined && value !== null) data[key as string] = value as number | boolean;
    };

    (
      [
        "runs",
        "ballsFaced",
        "fours",
        "sixes",
        "isOut",
        "ballsBowled",
        "maidens",
        "runsConceded",
        "wickets",
        "catches",
        "stumpings",
        "runOutsDirect",
        "runOutsIndirect",
      ] as (keyof IncomingPlayerStats)[]
    ).forEach(copy);

    await prisma.matchPlayerInnings.upsert({
      where: {
        matchPlayerId_inningsNumber: {
          matchPlayerId: target.id,
          inningsNumber: incoming.inningsNumber,
        },
      },
      create: {
        matchPlayerId: target.id,
        inningsNumber: incoming.inningsNumber,
        ...data,
      },
      update: data,
    });

    touched.add(target.id);
    playersUpdated += 1;
  }

  // The aggregate on MatchPlayer is what the rest of the app reads.
  for (const matchPlayerId of touched) {
    await syncMatchPlayerAggregate(matchPlayerId);
  }

  // ---- Team scoreboard ----
  const teams = [link.match.teamA, link.match.teamB].filter(Boolean) as {
    id: string;
    name: string;
    shortName: string;
  }[];

  let inningsUpdated = 0;

  for (const innings of input.innings) {
    const wanted = normaliseName(innings.teamName);
    const team = teams.find(
      (candidate) =>
        normaliseName(candidate.name) === wanted || normaliseName(candidate.shortName) === wanted
    );

    if (!team) {
      skipped.push(`innings ${innings.inningsNumber} (${innings.teamName})`);
      continue;
    }

    await prisma.matchInnings.upsert({
      where: {
        matchId_inningsNumber: {
          matchId: link.matchId,
          inningsNumber: innings.inningsNumber,
        },
      },
      create: {
        matchId: link.matchId,
        teamId: team.id,
        inningsNumber: innings.inningsNumber,
        runs: innings.runs,
        wickets: innings.wickets,
        balls: oversToBalls(innings.overs),
      },
      update: {
        teamId: team.id,
        runs: innings.runs,
        wickets: innings.wickets,
        balls: oversToBalls(innings.overs),
      },
    });

    inningsUpdated += 1;
  }

  await prisma.matchLiveLink.update({
    where: { id: link.id },
    data: { lastScoreAt: new Date() },
  });

  return { matchId: link.matchId, playersUpdated, inningsUpdated, skipped };
}
