import {
  BUDGET_CREDITS,
  MAX_PLAYERS_FROM_ONE_TEAM,
  TOTAL_PLAYERS,
  getRoleRules,
} from "./teamRules";

/**
 * Builds fantasy teams from a pool an admin has chosen.
 *
 * Teams are ranked, not sampled: every eleven is scored by the sum of
 * its players' priorities, and the highest scoring are handed out first.
 * Asking for a hundred teams from a pool that can make thirteen hundred
 * gives the hundred best, not a hundred at random.
 *
 * Every team still satisfies the rules a player faces by hand — eleven
 * picks, one of each role, a hundred credits, seven from one side.
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
  /** Weight in the ranking. Blank in the panel counts as 0. */
  priority: number;
}

export interface GeneratedTeam {
  matchPlayerIds: string[];
  captainId: string;
  viceCaptainId: string;
  credits: number;
  /** Sum of the eleven players' priorities — what they were ranked on. */
  priorityScore: number;
}

export interface GenerateResult {
  teams: GeneratedTeam[];
  failed: number;
  /** True when the same eleven had to be reused with the same leaders. */
  repeated: boolean;
  /** How many distinct elevens were handed out. */
  distinctElevens: number;
}

interface Candidate {
  ids: string[];
  score: number;
  credits: number;
}

/**
 * A bounded min-heap of the best candidates seen.
 *
 * Only the top N are ever needed, so the weakest is dropped as better
 * ones arrive — keeping every combination would run to millions on a
 * large pool.
 */
class BestOf {
  private items: Candidate[] = [];

  constructor(private readonly limit: number) {}

  get size() {
    return this.items.length;
  }

  /** The weakest score kept, or -Infinity until the heap is full. */
  get threshold(): number {
    if (this.items.length < this.limit) return Number.NEGATIVE_INFINITY;
    return this.items[0].score;
  }

  add(candidate: Candidate) {
    if (this.items.length < this.limit) {
      this.items.push(candidate);
      this.bubbleUp(this.items.length - 1);
      return;
    }

    if (candidate.score <= this.items[0].score) return;

    this.items[0] = candidate;
    this.bubbleDown(0);
  }

  /** Best first. */
  drain(): Candidate[] {
    return [...this.items].sort((a, b) => b.score - a.score);
  }

  private bubbleUp(index: number) {
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.items[parent].score <= this.items[index].score) break;
      [this.items[parent], this.items[index]] = [this.items[index], this.items[parent]];
      index = parent;
    }
  }

  private bubbleDown(index: number) {
    const size = this.items.length;
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;

      if (left < size && this.items[left].score < this.items[smallest].score) smallest = left;
      if (right < size && this.items[right].score < this.items[smallest].score) smallest = right;
      if (smallest === index) break;

      [this.items[smallest], this.items[index]] = [this.items[index], this.items[smallest]];
      index = smallest;
    }
  }
}

/**
 * Finds the highest-scoring elevens.
 *
 * Depth-first over players sorted by priority, pruning any branch whose
 * best possible finish can't beat what's already been kept. On a large
 * pool that turns tens of millions of combinations into thousands of
 * visited nodes.
 */
function findBestElevens(
  pool: PoolPlayer[],
  sport: "CRICKET" | "FOOTBALL",
  want: number,
  captainPool: Set<string>,
  vicePool: Set<string>
): Candidate[] {
  const roleRules = getRoleRules(sport);

  // Highest priority first, cheaper first within a tie. That order makes
  // the bound tight, so pruning starts early.
  const players = [...pool].sort(
    (a, b) => b.priority - a.priority || a.creditValue - b.creditValue
  );

  const n = players.length;

  // The best score any r players from index i could contribute.
  const bestAhead: number[][] = [];
  for (let i = 0; i <= n; i += 1) {
    const row: number[] = [0];
    let running = 0;
    for (let r = 1; r <= TOTAL_PLAYERS; r += 1) {
      const at = i + r - 1;
      if (at < n) {
        running += players[at].priority;
        row.push(running);
      } else {
        row.push(Number.NEGATIVE_INFINITY);
      }
    }
    bestAhead.push(row);
  }

  // The cheapest r players from index i, for the budget bound.
  const cheapestAhead: number[][] = [];
  for (let i = 0; i <= n; i += 1) {
    const costs = players
      .slice(i)
      .map((p) => p.creditValue)
      .sort((a, b) => a - b);

    const row: number[] = [0];
    let running = 0;
    for (let r = 1; r <= TOTAL_PLAYERS; r += 1) {
      running += r - 1 < costs.length ? costs[r - 1] : Number.POSITIVE_INFINITY;
      row.push(running);
    }
    cheapestAhead.push(row);
  }

  const best = new BestOf(want);

  const chosen: PoolPlayer[] = [];
  const byRole = new Map<string, number>();
  const bySide = new Map<string, number>();

  // Bounded so a pathological pool can't run for ever; generous enough
  // that realistic ones finish the whole search.
  let steps = 0;
  const MAX_STEPS = 4_000_000;

  function search(index: number, score: number, credits: number) {
    if (steps++ > MAX_STEPS) return;

    const slotsLeft = TOTAL_PLAYERS - chosen.length;

    if (slotsLeft === 0) {
      const ids = chosen.map((p) => p.matchPlayerId);

      // An eleven with no possible captain pair can never be used, so it
      // shouldn't take up one of the places kept.
      const caps = ids.filter((id) => captainPool.has(id));
      const vices = ids.filter((id) => vicePool.has(id));
      if (caps.some((c) => vices.some((v) => v !== c))) {
        best.add({ ids, score, credits });
      }

      return;
    }

    if (n - index < slotsLeft) return;

    // Optimistic: even with the best players left, can this branch beat
    // the weakest result already kept?
    const ceiling = score + bestAhead[index][slotsLeft];
    if (ceiling <= best.threshold) return;

    // And can it still be afforded?
    if (credits + cheapestAhead[index][slotsLeft] > BUDGET_CREDITS) return;

    const player = players[index];
    const rule = roleRules[player.role];

    if (rule) {
      const roleCount = byRole.get(player.role) ?? 0;
      const sideCount = bySide.get(player.teamId) ?? 0;

      // Roles still short of their minimum need places kept for them.
      let owed = 0;
      for (const [role, ruleFor] of Object.entries(roleRules)) {
        const have = (byRole.get(role) ?? 0) + (role === player.role ? 1 : 0);
        owed += Math.max(ruleFor.min - have, 0);
      }

      if (
        roleCount < rule.max &&
        sideCount < MAX_PLAYERS_FROM_ONE_TEAM &&
        credits + player.creditValue <= BUDGET_CREDITS &&
        owed <= slotsLeft - 1
      ) {
        chosen.push(player);
        byRole.set(player.role, roleCount + 1);
        bySide.set(player.teamId, sideCount + 1);

        search(index + 1, score + player.priority, credits + player.creditValue);

        chosen.pop();
        byRole.set(player.role, roleCount);
        bySide.set(player.teamId, sideCount);
      }
    }

    search(index + 1, score, credits);
  }

  search(0, 0, 0);

  return best.drain();
}

/**
 * Builds one team per user, best first.
 *
 * A different eleven is preferred over the same eleven with the armband
 * moved. Only once every eleven found has been used does a squad get a
 * second captain pair, and only after that does a team repeat outright.
 */
export function generateTeams(input: {
  pool: PoolPlayer[];
  count: number;
  sport: "CRICKET" | "FOOTBALL";
  captainPool: string[];
  viceCaptainPool: string[];
  random?: () => number;
}): GenerateResult {
  const { pool, count, sport } = input;
  const random = input.random ?? Math.random;

  const captainPool = new Set(input.captainPool);
  const vicePool = new Set(input.viceCaptainPool);

  // A little beyond what was asked, so there's something to fall back on
  // when an eleven turns out to allow only one captain pair.
  const elevens = findBestElevens(
    pool,
    sport,
    Math.max(count, Math.min(count * 2, count + 500)),
    captainPool,
    vicePool
  );

  if (elevens.length === 0) {
    return { teams: [], failed: count, repeated: false, distinctElevens: 0 };
  }

  /** Every captain pair an eleven allows, in a stable order. */
  function pairsFor(ids: string[]): { captainId: string; viceCaptainId: string }[] {
    const caps = ids.filter((id) => captainPool.has(id));
    const vices = ids.filter((id) => vicePool.has(id));

    const pairs: { captainId: string; viceCaptainId: string }[] = [];
    for (const captainId of caps) {
      for (const viceCaptainId of vices) {
        if (viceCaptainId !== captainId) pairs.push({ captainId, viceCaptainId });
      }
    }
    return pairs;
  }

  const teams: GeneratedTeam[] = [];
  const used = new Set<string>();

  const push = (
    eleven: Candidate,
    pair: { captainId: string; viceCaptainId: string }
  ) => {
    teams.push({
      matchPlayerIds: eleven.ids,
      captainId: pair.captainId,
      viceCaptainId: pair.viceCaptainId,
      credits: Math.round(eleven.credits * 10) / 10,
      priorityScore: eleven.score,
    });
    used.add([...eleven.ids].sort().join("|") + pair.captainId + pair.viceCaptainId);
  };

  // Pass one: the best elevens, each used once.
  for (const eleven of elevens) {
    if (teams.length >= count) break;

    const pairs = pairsFor(eleven.ids);
    if (pairs.length === 0) continue;

    push(eleven, pairs[Math.floor(random() * pairs.length)]);
  }

  const distinctElevens = teams.length;
  let repeated = false;

  // Pass two: the same elevens again, with a captain pair not yet used.
  for (;;) {
    if (teams.length >= count) break;

    let progress = false;

    for (const eleven of elevens) {
      if (teams.length >= count) break;

      for (const pair of pairsFor(eleven.ids)) {
        const key = [...eleven.ids].sort().join("|") + pair.captainId + pair.viceCaptainId;
        if (used.has(key)) continue;

        push(eleven, pair);
        progress = true;
        break;
      }
    }

    if (!progress) break;
  }

  // Pass three: nothing distinct is left, so teams start repeating —
  // better than leaving users without one.
  while (teams.length < count) {
    repeated = true;

    for (const eleven of elevens) {
      if (teams.length >= count) break;

      const pairs = pairsFor(eleven.ids);
      if (pairs.length === 0) continue;

      push(eleven, pairs[Math.floor(random() * pairs.length)]);
    }
  }

  return {
    teams: teams.slice(0, count),
    failed: Math.max(count - teams.length, 0),
    repeated,
    distinctElevens,
  };
}
