// Converts raw match stats into fantasy points using ADMIN-CONFIGURABLE
// rules (stored in PointSystem.rules per sport+format). This file defines
// the rule shapes, the built-in default rule sets (matching the provided
// T20/ODI/Test/T10/H100 scoring sheet exactly), and the pure calculation
// functions. Admins edit the numbers via the Point System screen; nothing
// here is hardcoded into the calculation logic itself.

export interface Milestone {
  threshold: number; // e.g. runs, or wickets
  bonus: number;
}

export interface RateBand {
  min: number;
  max: number; // use a large number (e.g. 9999) for "and above"
  points: number;
}

export interface CricketPointRules {
  perRun: number;
  perFour: number;
  perSix: number;
  // Only the HIGHEST milestone reached applies (not cumulative).
  runMilestones: Milestone[]; // threshold = runs scored
  duckPenalty: number; // applied when isOut && runs === 0 (non-bowlers)

  strikeRateBands: RateBand[]; // empty = strike rate not scored for this format
  srQualifyMinRuns: number;
  srQualifyMinBalls: number; // qualifies if runs>=X OR ballsFaced>=Y

  perWicket: number;
  // Only the HIGHEST haul tier reached applies (not cumulative).
  wicketHaulBonuses: Milestone[]; // threshold = wickets taken
  perMaiden: number;
  lbwBowledBonus: number; // extra bonus per wicket that was Bowled or LBW

  dotBallBonusPoints: number;
  dotBallsPerBonus: number; // e.g. 1 = every dot ball, 3 = every 3 dot balls

  economyBands: RateBand[]; // empty = economy rate not scored for this format
  economyQualifyMinOvers: number;

  perCatch: number;
  threeCatchBonus: number;
  perStumping: number;
  perRunOutDirect: number;
  perRunOutIndirect: number;

  playingXIBonus: number;
  captainMultiplier: number;
  viceCaptainMultiplier: number;
}

export interface FootballPointRules {
  appearancePoints: number;
  fullAppearancePoints: number;
  goalPointsFwd: number;
  goalPointsMid: number;
  goalPointsDef: number;
  assistPoints: number;
  cleanSheetPoints: number;
  yellowCardPenalty: number;
  redCardPenalty: number;
  ownGoalPenalty: number;
  penaltySavedPoints: number;
  penaltyMissedPenalty: number;
  perThreeSaves: number;
  playingXIBonus: number;
  captainMultiplier: number;
  viceCaptainMultiplier: number;
}

// ---------- Helpers ----------

function highestMilestone(value: number, milestones: Milestone[]): number {
  let best = 0;
  for (const m of milestones) {
    if (value >= m.threshold && m.bonus > best) best = m.bonus;
  }
  return best;
}

function bandPoints(value: number, bands: RateBand[]): number {
  for (const b of bands) {
    if (value >= b.min && value <= b.max) return b.points;
  }
  return 0;
}

// ---------- Cricket ----------

export interface CricketMatchStats {
  isPlaying: boolean;
  runs: number;
  ballsFaced: number;
  fours: number;
  sixes: number;
  isOut: boolean;
  ballsBowled: number;
  dotBalls: number;
  maidens: number;
  runsConceded: number;
  wickets: number;
  wicketsBowledOrLBW: number;
  catches: number;
  runOutsDirect: number;
  runOutsIndirect: number;
  stumpings: number;
}

export function calculateCricketPoints(stats: CricketMatchStats, role: string, rules: CricketPointRules): number {
  let points = 0;

  if (stats.isPlaying) points += rules.playingXIBonus;

  // Batting
  points += stats.runs * rules.perRun;
  points += stats.fours * rules.perFour;
  points += stats.sixes * rules.perSix;
  points += highestMilestone(stats.runs, rules.runMilestones);
  if (stats.isOut && stats.runs === 0 && role !== "BOWL") points += rules.duckPenalty;

  if (rules.strikeRateBands.length > 0 && (stats.runs >= rules.srQualifyMinRuns || stats.ballsFaced >= rules.srQualifyMinBalls) && stats.ballsFaced > 0) {
    const sr = (stats.runs / stats.ballsFaced) * 100;
    points += bandPoints(sr, rules.strikeRateBands);
  }

  // Bowling
  points += stats.wickets * rules.perWicket;
  points += highestMilestone(stats.wickets, rules.wicketHaulBonuses);
  points += stats.maidens * rules.perMaiden;
  points += stats.wicketsBowledOrLBW * rules.lbwBowledBonus;
  if (rules.dotBallsPerBonus > 0) {
    points += Math.floor(stats.dotBalls / rules.dotBallsPerBonus) * rules.dotBallBonusPoints;
  }

  const oversBowled = stats.ballsBowled / 6;
  if (rules.economyBands.length > 0 && oversBowled >= rules.economyQualifyMinOvers && oversBowled > 0) {
    const economy = stats.runsConceded / oversBowled;
    points += bandPoints(economy, rules.economyBands);
  }

  // Fielding
  points += stats.catches * rules.perCatch;
  if (stats.catches >= 3) points += rules.threeCatchBonus;
  points += stats.stumpings * rules.perStumping;
  points += stats.runOutsDirect * rules.perRunOutDirect;
  points += stats.runOutsIndirect * rules.perRunOutIndirect;

  return Math.round(points * 10) / 10;
}

// ---------- Football ----------

export interface FootballMatchStats {
  isPlaying: boolean;
  minutesPlayed: number;
  goals: number;
  assists: number;
  cleanSheet: boolean;
  yellowCards: number;
  redCards: number;
  ownGoals: number;
  penaltiesSaved: number;
  penaltiesMissed: number;
  saves: number;
}

export function calculateFootballPoints(stats: FootballMatchStats, role: string, rules: FootballPointRules): number {
  let points = 0;

  if (stats.isPlaying) points += rules.playingXIBonus;
  if (stats.minutesPlayed >= 60) points += rules.fullAppearancePoints;
  else if (stats.minutesPlayed > 0) points += rules.appearancePoints;

  const goalPoints = role === "FWD" ? rules.goalPointsFwd : role === "MID" ? rules.goalPointsMid : rules.goalPointsDef;
  points += stats.goals * goalPoints;
  points += stats.assists * rules.assistPoints;

  if (stats.cleanSheet && stats.minutesPlayed >= 60 && (role === "GK" || role === "DEF")) {
    points += rules.cleanSheetPoints;
  }

  if (role === "GK") {
    points += Math.floor(stats.saves / 3) * rules.perThreeSaves;
    points += stats.penaltiesSaved * rules.penaltySavedPoints;
  }

  points += stats.yellowCards * rules.yellowCardPenalty;
  points += stats.redCards * rules.redCardPenalty;
  points += stats.ownGoals * rules.ownGoalPenalty;
  points += stats.penaltiesMissed * rules.penaltyMissedPenalty;

  return Math.round(points * 10) / 10;
}

// ---------- Default rule sets (from the provided scoring sheet) ----------

const COMMON_FIELDING = { perCatch: 8, threeCatchBonus: 4, perStumping: 12, perRunOutDirect: 12, perRunOutIndirect: 6 };
const COMMON_OTHERS = { playingXIBonus: 4, captainMultiplier: 2, viceCaptainMultiplier: 1.5 };

export const DEFAULT_CRICKET_RULES_T20: CricketPointRules = {
  perRun: 1, perFour: 4, perSix: 6,
  runMilestones: [{ threshold: 25, bonus: 4 }, { threshold: 50, bonus: 8 }, { threshold: 75, bonus: 12 }, { threshold: 100, bonus: 16 }, { threshold: 150, bonus: 25 }],
  duckPenalty: -2,
  strikeRateBands: [
    { min: 0, max: 49.99, points: -6 }, { min: 50, max: 59.99, points: -4 }, { min: 60, max: 69.99, points: -2 },
    { min: 70, max: 129.99, points: 0 }, { min: 130, max: 149.99, points: 2 }, { min: 150, max: 169.99, points: 4 },
    { min: 170, max: 9999, points: 6 },
  ],
  srQualifyMinRuns: 20, srQualifyMinBalls: 10,
  perWicket: 30,
  wicketHaulBonuses: [{ threshold: 3, bonus: 4 }, { threshold: 4, bonus: 8 }, { threshold: 5, bonus: 12 }],
  perMaiden: 12, lbwBowledBonus: 8,
  dotBallBonusPoints: 1, dotBallsPerBonus: 1,
  economyBands: [
    { min: 0, max: 4.99, points: 6 }, { min: 5, max: 5.99, points: 4 }, { min: 6, max: 6.99, points: 2 },
    { min: 7, max: 9.99, points: 0 }, { min: 10, max: 10.99, points: -2 }, { min: 11, max: 11.99, points: -4 },
    { min: 12, max: 9999, points: -6 },
  ],
  economyQualifyMinOvers: 2,
  ...COMMON_FIELDING, ...COMMON_OTHERS,
};

export const DEFAULT_CRICKET_RULES_ODI: CricketPointRules = {
  perRun: 1, perFour: 4, perSix: 6,
  runMilestones: [{ threshold: 25, bonus: 4 }, { threshold: 50, bonus: 8 }, { threshold: 75, bonus: 12 }, { threshold: 100, bonus: 16 }, { threshold: 150, bonus: 25 }, { threshold: 200, bonus: 35 }],
  duckPenalty: -3,
  strikeRateBands: [
    { min: 0, max: 29.99, points: -6 }, { min: 30, max: 39.99, points: -4 }, { min: 40, max: 49.99, points: -2 },
    { min: 50, max: 99.99, points: 0 }, { min: 100, max: 119.99, points: 2 }, { min: 120, max: 139.99, points: 4 },
    { min: 140, max: 9999, points: 6 },
  ],
  srQualifyMinRuns: 20, srQualifyMinBalls: 10,
  perWicket: 30,
  wicketHaulBonuses: [{ threshold: 4, bonus: 4 }, { threshold: 5, bonus: 8 }, { threshold: 6, bonus: 12 }],
  perMaiden: 4, lbwBowledBonus: 8,
  dotBallBonusPoints: 1, dotBallsPerBonus: 3,
  economyBands: [
    { min: 0, max: 2.49, points: 6 }, { min: 2.5, max: 3.49, points: 4 }, { min: 3.5, max: 4.49, points: 2 },
    { min: 4.5, max: 6.99, points: 0 }, { min: 7, max: 7.99, points: -2 }, { min: 8, max: 8.99, points: -4 },
    { min: 9, max: 9999, points: -6 },
  ],
  economyQualifyMinOvers: 5,
  ...COMMON_FIELDING, ...COMMON_OTHERS,
};

export const DEFAULT_CRICKET_RULES_TEST: CricketPointRules = {
  perRun: 1, perFour: 4, perSix: 6,
  runMilestones: [{ threshold: 25, bonus: 4 }, { threshold: 50, bonus: 8 }, { threshold: 75, bonus: 12 }, { threshold: 100, bonus: 16 }, { threshold: 150, bonus: 25 }, { threshold: 200, bonus: 35 }],
  duckPenalty: 0,
  strikeRateBands: [], srQualifyMinRuns: 0, srQualifyMinBalls: 0,
  perWicket: 20,
  wicketHaulBonuses: [{ threshold: 4, bonus: 4 }, { threshold: 5, bonus: 8 }, { threshold: 6, bonus: 12 }],
  perMaiden: 0, lbwBowledBonus: 8,
  dotBallBonusPoints: 0, dotBallsPerBonus: 1,
  economyBands: [], economyQualifyMinOvers: 0,
  ...COMMON_FIELDING, ...COMMON_OTHERS,
};

export const DEFAULT_CRICKET_RULES_T10: CricketPointRules = {
  perRun: 1, perFour: 4, perSix: 6,
  runMilestones: [{ threshold: 25, bonus: 8 }, { threshold: 50, bonus: 8 }, { threshold: 75, bonus: 12 }, { threshold: 100, bonus: 16 }, { threshold: 150, bonus: 25 }],
  duckPenalty: -2,
  strikeRateBands: [
    { min: 0, max: 59.99, points: -6 }, { min: 60, max: 69.99, points: -4 }, { min: 70, max: 79.99, points: -2 },
    { min: 80, max: 149.99, points: 0 }, { min: 150, max: 169.99, points: 2 }, { min: 170, max: 189.99, points: 4 },
    { min: 190, max: 9999, points: 6 },
  ],
  srQualifyMinRuns: 10, srQualifyMinBalls: 5,
  perWicket: 30,
  wicketHaulBonuses: [{ threshold: 2, bonus: 4 }, { threshold: 3, bonus: 8 }, { threshold: 4, bonus: 12 }, { threshold: 5, bonus: 16 }],
  perMaiden: 16, lbwBowledBonus: 8,
  dotBallBonusPoints: 1, dotBallsPerBonus: 1,
  economyBands: [
    { min: 0, max: 6.99, points: 6 }, { min: 7, max: 7.99, points: 4 }, { min: 8, max: 8.99, points: 2 },
    { min: 9, max: 13.99, points: 0 }, { min: 14, max: 14.99, points: -2 }, { min: 15, max: 15.99, points: -4 },
    { min: 16, max: 9999, points: -6 },
  ],
  economyQualifyMinOvers: 1,
  ...COMMON_FIELDING, ...COMMON_OTHERS,
};

export const DEFAULT_CRICKET_RULES_H100: CricketPointRules = {
  perRun: 1, perFour: 4, perSix: 6,
  runMilestones: [{ threshold: 30, bonus: 5 }, { threshold: 50, bonus: 10 }, { threshold: 100, bonus: 16 }],
  duckPenalty: -2,
  strikeRateBands: [], srQualifyMinRuns: 0, srQualifyMinBalls: 0,
  perWicket: 25,
  wicketHaulBonuses: [{ threshold: 2, bonus: 3 }, { threshold: 3, bonus: 5 }, { threshold: 4, bonus: 10 }, { threshold: 5, bonus: 20 }],
  perMaiden: 0, lbwBowledBonus: 8,
  dotBallBonusPoints: 0, dotBallsPerBonus: 1,
  economyBands: [], economyQualifyMinOvers: 0,
  ...COMMON_FIELDING, ...COMMON_OTHERS,
};

// Kept as the generic fallback (used if a sport has zero configured PointSystem rows)
export const DEFAULT_CRICKET_RULES = DEFAULT_CRICKET_RULES_T20;

export const DEFAULT_FOOTBALL_RULES: FootballPointRules = {
  appearancePoints: 1, fullAppearancePoints: 2,
  goalPointsFwd: 4, goalPointsMid: 5, goalPointsDef: 6,
  assistPoints: 3, cleanSheetPoints: 4,
  yellowCardPenalty: -1, redCardPenalty: -3, ownGoalPenalty: -2,
  penaltySavedPoints: 5, penaltyMissedPenalty: -2, perThreeSaves: 1,
  playingXIBonus: 0, captainMultiplier: 2, viceCaptainMultiplier: 1.5,
};
