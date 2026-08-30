/**
 * Splitting prize money across tied entries.
 *
 * Entries that finish on the same points share a rank. The prizes for
 * every place they occupy are pooled and divided equally, so two people
 * on the same score always take home the same amount — luck of the
 * database ordering never decides who gets more.
 *
 * Worked example, prizes 1st=50, 2nd=40, 3rd=30:
 *
 *   A 425 -> rank 1 \  pool = 50 + 40 = 90, split two ways -> 45 each
 *   B 425 -> rank 1 /
 *   C 420 -> rank 3 \
 *   D 420 -> rank 3  > pool = 30 + 0 + 0 = 30, split three ways -> 10 each
 *   E 420 -> rank 3 /
 *
 * Total paid: 120 — exactly the configured pool, never more.
 */

export interface RankedEntry {
  id: string;
  userId: string;
  rank: number;
}

export interface Payout {
  entryId: string;
  userId: string;
  rank: number;
  coins: number;
  /** How many entries shared this rank. 1 means an outright finish. */
  sharedBy: number;
}

/**
 * @param entries    ranked entries, in leaderboard order (earliest joiner
 *                   first within a tie — used only to settle the odd coin)
 * @param prizeByRank  configured prize for each paying rank
 */
export function splitPrizes(
  entries: RankedEntry[],
  prizeByRank: Map<number, number>
): Payout[] {
  const payouts: Payout[] = [];

  // Group by rank. Entries arrive in leaderboard order, so each group's
  // internal order is already the tie-break order.
  const groups = new Map<number, RankedEntry[]>();
  for (const entry of entries) {
    const group = groups.get(entry.rank);
    if (group) group.push(entry);
    else groups.set(entry.rank, [entry]);
  }

  for (const [rank, group] of groups) {
    // A group sitting at rank 3 with three members occupies places
    // 3, 4 and 5 — so it collects the prizes for all three.
    let pool = 0;
    for (let place = rank; place < rank + group.length; place += 1) {
      pool += prizeByRank.get(place) ?? 0;
    }

    if (pool <= 0) continue;

    // Coins are whole numbers, so a pool that doesn't divide evenly
    // leaves a remainder. Handing it to the earliest joiners is
    // arbitrary but deterministic — the alternative is losing coins to
    // rounding, or paying out more than the pool.
    const base = Math.floor(pool / group.length);
    let remainder = pool - base * group.length;

    for (const entry of group) {
      const extra = remainder > 0 ? 1 : 0;
      remainder -= extra;

      const coins = base + extra;
      if (coins <= 0) continue;

      payouts.push({
        entryId: entry.id,
        userId: entry.userId,
        rank,
        coins,
        sharedBy: group.length,
      });
    }
  }

  return payouts;
}
