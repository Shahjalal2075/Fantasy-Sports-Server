import {
  BUDGET_CREDITS,
  MAX_PLAYERS_FROM_ONE_TEAM,
  TOTAL_PLAYERS,
  getRoleRules,
} from "./teamRules";

/**
 * Builds fantasy teams automatically from a pool an admin has chosen.
 *
 * Every team has to satisfy the same rules a player faces by hand: the
 * role minimums, eleven picks, a hundred credits, and no more than
 * seven from one real side. A team that breaks any of them would be
 * rejected by the app the moment someone opened it.
 */

export interface PoolPlayer {
  /** MatchPlayer id — what a UserTeamPlayer points at. */
  matchPlayerId: string;
  playerId: string;
  name: string;
  role: string;
  creditValue: number;
  /** The real side they play for, for the seven-per-team cap. */
  teamId: string;
  /**
   * How strongly to favour this player, 0 and up.
   *
   * Zero still means selectable — it's the baseline, not an exclusion.
   * An admin leaving the box empty shouldn't quietly drop someone from
   * the pool they deliberately picked.
   */
  priority: number;
}

export interface GeneratedTeam {
  matchPlayerIds: string[];
  captainId: string;
  viceCaptainId: string;
  /** Total credits used, for the admin's report. */
  credits: number;
}

/** Weighted pick without replacement. Higher priority, likelier chosen. */
function weightedPick(pool: PoolPlayer[], random: () => number): PoolPlayer | null {
  if (pool.length === 0) return null;

  // +1 so a priority of 0 still carries weight; otherwise the whole
  // pool would weigh nothing when nobody has been prioritised.
  const weights = pool.map((player) => player.priority + 1);
  const total = weights.reduce((sum, weight) => sum + weight, 0);

  let cursor = random() * total;
  for (let i = 0; i < pool.length; i += 1) {
    cursor -= weights[i];
    if (cursor <= 0) return pool[i];
  }

  return pool[pool.length - 1];
}

interface BuildState {
  chosen: PoolPlayer[];
  credits: number;
  byRole: Map<string, number>;
  bySide: Map<string, number>;
}

/**
 * The least this team could still cost after taking one more player.
 *
 * Without it the builder spends freely early and then finds the last
 * few slots unaffordable, throwing the whole attempt away. Looking
 * ahead at the cheapest legal completion turns most attempts into
 * usable teams instead.
 */
function cheapestCompletion(
  state: BuildState,
  pool: PoolPlayer[],
  taking: PoolPlayer,
  roleRules: Record<string, { min: number; max: number }>,
  slotsLeft: number
): number {
  if (slotsLeft <= 0) return 0;

  const used = new Set(state.chosen.map((row) => row.matchPlayerId));
  used.add(taking.matchPlayerId);

  const available = pool
    .filter((row) => !used.has(row.matchPlayerId))
    .sort((a, b) => a.creditValue - b.creditValue);

  let cost = 0;
  let filled = 0;
  const spoken = new Set<string>();

  // Roles still short of their minimum must be covered first — those
  // places aren't free to give to whoever happens to be cheapest.
  for (const [role, rule] of Object.entries(roleRules)) {
    const have = (state.byRole.get(role) ?? 0) + (taking.role === role ? 1 : 0);
    let owed = Math.max(rule.min - have, 0);

    for (const candidate of available) {
      if (owed === 0) break;
      if (candidate.role !== role || spoken.has(candidate.matchPlayerId)) continue;

      spoken.add(candidate.matchPlayerId);
      cost += candidate.creditValue;
      filled += 1;
      owed -= 1;
    }

    // A minimum that can't be met at all makes this branch hopeless.
    if (owed > 0) return Number.POSITIVE_INFINITY;
  }

  for (const candidate of available) {
    if (filled >= slotsLeft) break;
    if (spoken.has(candidate.matchPlayerId)) continue;

    spoken.add(candidate.matchPlayerId);
    cost += candidate.creditValue;
    filled += 1;
  }

  return filled < slotsLeft ? Number.POSITIVE_INFINITY : cost;
}

function canTake(
  state: BuildState,
  pool: PoolPlayer[],
  player: PoolPlayer,
  roleRules: Record<string, { min: number; max: number }>,
  remainingAfter: number
): boolean {
  if (state.chosen.some((row) => row.matchPlayerId === player.matchPlayerId)) return false;

  const rule = roleRules[player.role];
  if (!rule) return false;

  if ((state.byRole.get(player.role) ?? 0) >= rule.max) return false;
  if ((state.bySide.get(player.teamId) ?? 0) >= MAX_PLAYERS_FROM_ONE_TEAM) return false;
  if (state.credits + player.creditValue > BUDGET_CREDITS) return false;

  // Every role still short of its minimum needs a place kept for it.
  // Without this the budget gets spent on whoever comes first and the
  // last slot has no legal candidate left.
  let owed = 0;
  for (const [role, ruleFor] of Object.entries(roleRules)) {
    const have = (state.byRole.get(role) ?? 0) + (role === player.role ? 1 : 0);
    owed += Math.max(ruleFor.min - have, 0);
  }

  if (owed > remainingAfter) return false;

  return (
    state.credits + player.creditValue +
      cheapestCompletion(state, pool, player, roleRules, remainingAfter) <=
    BUDGET_CREDITS
  );
}

function take(state: BuildState, player: PoolPlayer) {
  state.chosen.push(player);
  state.credits += player.creditValue;
  state.byRole.set(player.role, (state.byRole.get(player.role) ?? 0) + 1);
  state.bySide.set(player.teamId, (state.bySide.get(player.teamId) ?? 0) + 1);
}

/**
 * One attempt at a valid eleven.
 *
 * Role minimums are filled first, because they're the constraint most
 * likely to fail: leaving them to chance means a pool heavy in batters
 * builds ten of them and then finds no keeper it can afford.
 */
function attemptTeam(
  pool: PoolPlayer[],
  sport: "CRICKET" | "FOOTBALL",
  random: () => number
): GeneratedTeam | null {
  const roleRules = getRoleRules(sport);

  const state: BuildState = {
    chosen: [],
    credits: 0,
    byRole: new Map(),
    bySide: new Map(),
  };

  for (const [role, rule] of Object.entries(roleRules)) {
    for (let n = 0; n < rule.min; n += 1) {
      const remainingAfter = TOTAL_PLAYERS - state.chosen.length - 1;

      const candidates = pool.filter(
        (player) => player.role === role && canTake(state, pool, player, roleRules, remainingAfter)
      );

      const picked = weightedPick(candidates, random);
      if (!picked) return null;

      take(state, picked);
    }
  }

  while (state.chosen.length < TOTAL_PLAYERS) {
    const remainingAfter = TOTAL_PLAYERS - state.chosen.length - 1;

    const candidates = pool.filter((player) => canTake(state, pool, player, roleRules, remainingAfter));
    const picked = weightedPick(candidates, random);
    if (!picked) return null;

    take(state, picked);
  }

  return {
    matchPlayerIds: state.chosen.map((player) => player.matchPlayerId),
    captainId: "",
    viceCaptainId: "",
    credits: Math.round(state.credits * 10) / 10,
  };
}

/** A team's fingerprint, so no two users get an identical one. */
function signature(team: GeneratedTeam): string {
  return [...team.matchPlayerIds].sort().join("|") + "::" + team.captainId + "::" + team.viceCaptainId;
}

export interface GenerateResult {
  teams: GeneratedTeam[];
  /** How many were asked for but couldn't be built. */
  failed: number;
}

/**
 * Builds one distinct team per user.
 *
 * Distinct means the eleven plus the captain pair: the same players with
 * a different captain counts as a different team, which is how a small
 * pool can still fill a lot of entries.
 */
export function generateTeams(input: {
  pool: PoolPlayer[];
  count: number;
  sport: "CRICKET" | "FOOTBALL";
  captainPool: string[];
  viceCaptainPool: string[];
  random?: () => number;
}): GenerateResult {
  const { pool, count, sport, captainPool, viceCaptainPool } = input;
  const random = input.random ?? Math.random;

  const teams: GeneratedTeam[] = [];
  const seen = new Set<string>();

  // Generous, because a near-exhausted pool rejects many attempts before
  // finding a combination it hasn't used — but bounded, so an impossible
  // pool fails in a moment rather than spinning.
  const maxAttempts = count * 60 + 400;
  let attempts = 0;

  while (teams.length < count && attempts < maxAttempts) {
    attempts += 1;

    const team = attemptTeam(pool, sport, random);
    if (!team) continue;

    // The captain has to be in the eleven that was just built.
    const captains = captainPool.filter((id) => team.matchPlayerIds.includes(id));
    if (captains.length === 0) continue;

    const captainId = captains[Math.floor(random() * captains.length)];

    const vices = viceCaptainPool.filter(
      (id) => team.matchPlayerIds.includes(id) && id !== captainId
    );
    if (vices.length === 0) continue;

    const viceCaptainId = vices[Math.floor(random() * vices.length)];

    const finished: GeneratedTeam = { ...team, captainId, viceCaptainId };

    const key = signature(finished);
    if (seen.has(key)) continue;

    seen.add(key);
    teams.push(finished);
  }

  return { teams, failed: count - teams.length };
}
