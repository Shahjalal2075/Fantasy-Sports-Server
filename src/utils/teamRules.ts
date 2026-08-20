// Dream11-style roster rules, defined per sport.
// Role strings must match what's stored on Player.role in the DB.

export const TOTAL_PLAYERS = 11;
export const BUDGET_CREDITS = 100;
export const MAX_PLAYERS_FROM_ONE_TEAM = 7;
// A user may build at most this many fantasy teams for a single match.
export const MAX_TEAMS_PER_MATCH = 6;

interface RoleRule {
  min: number;
  max: number;
}

// Cricket roles: WK (wicket-keeper), BAT (batsman), AR (all-rounder), BOWL (bowler)
const CRICKET_ROLE_RULES: Record<string, RoleRule> = {
  WK: { min: 1, max: 4 },
  BAT: { min: 3, max: 6 },
  AR: { min: 1, max: 4 },
  BOWL: { min: 3, max: 6 },
};

// Football roles: GK (goalkeeper), DEF (defender), MID (midfielder), FWD (forward)
const FOOTBALL_ROLE_RULES: Record<string, RoleRule> = {
  GK: { min: 1, max: 1 },
  DEF: { min: 3, max: 5 },
  MID: { min: 3, max: 5 },
  FWD: { min: 1, max: 3 },
};

export function getRoleRules(sport: "CRICKET" | "FOOTBALL"): Record<string, RoleRule> {
  return sport === "CRICKET" ? CRICKET_ROLE_RULES : FOOTBALL_ROLE_RULES;
}

export interface PlayerForValidation {
  id: string;
  teamId: string;
  role: string;
  creditValue: number;
  isPlaying: boolean;
}

export interface TeamValidationResult {
  valid: boolean;
  errors: string[];
}

// Runs every roster rule against a candidate set of 11 players + captain/VC.
// Pure function — no DB access — so it's easy to unit test on its own.
export function validateTeamSelection(
  sport: "CRICKET" | "FOOTBALL",
  selectedPlayers: PlayerForValidation[],
  captainId: string,
  viceCaptainId: string,
  teamNames?: Record<string, string>
): TeamValidationResult {
  const errors: string[] = [];
  const roleRules = getRoleRules(sport);

  // 1. Exact count
  if (selectedPlayers.length !== TOTAL_PLAYERS) {
    errors.push(`You must select exactly ${TOTAL_PLAYERS} players (got ${selectedPlayers.length})`);
  }

  // 2. No duplicate players
  const uniqueIds = new Set(selectedPlayers.map((p) => p.id));
  if (uniqueIds.size !== selectedPlayers.length) {
    errors.push("Duplicate players are not allowed in the same team");
  }

  // 3. All selected players must currently be marked as playing
  const notPlaying = selectedPlayers.filter((p) => !p.isPlaying);
  if (notPlaying.length > 0) {
    errors.push(`These players are not in the playing XI: ${notPlaying.map((p) => p.id).join(", ")}`);
  }

  // 4. Budget check
  const totalCredits = selectedPlayers.reduce((sum, p) => sum + p.creditValue, 0);
  if (totalCredits > BUDGET_CREDITS) {
    errors.push(`Team exceeds the ${BUDGET_CREDITS}-credit budget (used ${totalCredits.toFixed(1)})`);
  }

  // 5. Role composition (min/max per role)
  const roleCounts: Record<string, number> = {};
  for (const p of selectedPlayers) {
    roleCounts[p.role] = (roleCounts[p.role] || 0) + 1;
  }
  for (const [role, rule] of Object.entries(roleRules)) {
    const count = roleCounts[role] || 0;
    if (count < rule.min || count > rule.max) {
      errors.push(`${role} count must be between ${rule.min} and ${rule.max} (got ${count})`);
    }
  }
  // Any role present that isn't recognized for this sport
  for (const role of Object.keys(roleCounts)) {
    if (!roleRules[role]) {
      errors.push(`Unrecognized role "${role}" for ${sport}`);
    }
  }

  // 6. Max players from a single real-life team (e.g. max 7 from Team A)
  const teamCounts: Record<string, number> = {};
  for (const p of selectedPlayers) {
    teamCounts[p.teamId] = (teamCounts[p.teamId] || 0) + 1;
  }
  for (const [teamId, count] of Object.entries(teamCounts)) {
    if (count > MAX_PLAYERS_FROM_ONE_TEAM) {
      const label = teamNames?.[teamId] ?? teamId;
      errors.push(`Maximum ${MAX_PLAYERS_FROM_ONE_TEAM} players allowed from ${label} (got ${count})`);
    }
  }

  // 7. Captain / Vice-captain must be part of the selected 11, and must differ
  if (!uniqueIds.has(captainId)) {
    errors.push("Captain must be one of the selected players");
  }
  if (!uniqueIds.has(viceCaptainId)) {
    errors.push("Vice-captain must be one of the selected players");
  }
  if (captainId === viceCaptainId) {
    errors.push("Captain and Vice-captain must be different players");
  }

  return { valid: errors.length === 0, errors };
}

export interface PlayerWithPoints {
  id: string;
  points: number;
}

// Fantasy scoring multiplier: captain/vice-captain multipliers are
// admin-configurable per PointSystem (see fantasyScoring.ts), defaulting
// to the standard 2x / 1.5x. Everyone else earns 1x.
export function computeTeamPoints(
  players: PlayerWithPoints[],
  captainId: string,
  viceCaptainId: string,
  captainMultiplier = 2,
  viceCaptainMultiplier = 1.5
): number {
  return players.reduce((total, p) => {
    if (p.id === captainId) return total + p.points * captainMultiplier;
    if (p.id === viceCaptainId) return total + p.points * viceCaptainMultiplier;
    return total + p.points;
  }, 0);
}
