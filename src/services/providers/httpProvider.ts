import { SportsDataProvider, ExternalMatchData, ExternalPlayerStatLine } from "../sportsDataProvider";

// TEMPLATE for a real provider (e.g. CricAPI for cricket, API-Football for
// football, SportMonks for either). This file intentionally does NOT call
// a real endpoint yet — every sports-data API has a different response
// shape, so you'll adjust the fetch URL, headers, and the mapping function
// below once you've picked and signed up for a provider. The overall shape
// (fetch -> map to ExternalMatchData) stays the same regardless of provider.
//
// Steps to go live:
// 1. Sign up for a provider and get an API key.
// 2. Put the key in .env, e.g. SPORTS_API_KEY=xxxx and SPORTS_API_BASE_URL=https://...
// 3. Fill in the fetch call and field mapping below to match that provider's
//    actual JSON response (check their docs — field names vary a lot).
// 4. Set SPORTS_DATA_PROVIDER=http in .env to switch away from the mock provider.
export class HttpSportsDataProvider implements SportsDataProvider {
  private apiKey: string;
  private baseUrl: string;

  constructor() {
    this.apiKey = process.env.SPORTS_API_KEY || "";
    this.baseUrl = process.env.SPORTS_API_BASE_URL || "";

    if (!this.apiKey || !this.baseUrl) {
      throw new Error(
        "SPORTS_API_KEY and SPORTS_API_BASE_URL must be set in .env to use HttpSportsDataProvider"
      );
    }
  }

  async fetchMatchStats(
    externalMatchId: string,
    sport: "CRICKET" | "FOOTBALL"
  ): Promise<ExternalMatchData> {
    // Example call shape — replace the path/params with your provider's real
    // "match scorecard" or "fixture stats" endpoint.
    const response = await fetch(`${this.baseUrl}/matches/${externalMatchId}/scorecard`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });

    if (!response.ok) {
      throw new Error(`Sports data provider request failed: ${response.status} ${response.statusText}`);
    }

    const raw: any = await response.json();

    // ---- Map the provider's response shape into our internal shape ----
    // This is the ONLY part that changes per-provider. Below is a
    // placeholder mapping assuming a generic { completed, players: [...] }
    // shape — replace with real field names from your provider's docs.
    const players: ExternalPlayerStatLine[] = (raw.players ?? []).map((p: any) =>
      sport === "CRICKET"
        ? {
            playerName: p.name,
            cricketStats: {
              isPlaying: p.is_playing ?? true,
              runs: p.runs ?? 0,
              fours: p.fours ?? 0,
              sixes: p.sixes ?? 0,
              ballsFaced: p.balls_faced ?? 0,
              wickets: p.wickets ?? 0,
              wicketsBowledOrLBW: p.wickets_bowled_or_lbw ?? 0,
              maidens: p.maidens ?? 0,
              catches: p.catches ?? 0,
              stumpings: p.stumpings ?? 0,
              runOuts: p.run_outs ?? 0,
              ballsBowled: p.balls_bowled ?? 0,
              runsConceded: p.runs_conceded ?? 0,
              dismissedForDuck: (p.runs ?? 0) === 0 && p.was_dismissed === true,
            },
          }
        : {
            playerName: p.name,
            footballStats: {
              isPlaying: p.is_playing ?? true,
              minutesPlayed: p.minutes_played ?? 0,
              goals: p.goals ?? 0,
              assists: p.assists ?? 0,
              cleanSheet: p.clean_sheet ?? false,
              goalsConceded: p.goals_conceded ?? 0,
              yellowCards: p.yellow_cards ?? 0,
              redCards: p.red_cards ?? 0,
              ownGoals: p.own_goals ?? 0,
              penaltiesSaved: p.penalties_saved ?? 0,
              penaltiesMissed: p.penalties_missed ?? 0,
              saves: p.saves ?? 0,
            },
          }
    );

    return {
      isMatchComplete: raw.completed === true,
      players,
    };
  }
}
