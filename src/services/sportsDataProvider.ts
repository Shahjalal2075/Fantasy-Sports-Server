// Provider-agnostic contract for fetching live/completed match stats from
// an external sports data API. Swap in a real provider (CricAPI, SportMonks,
// API-Football, etc.) by implementing this interface — nothing else in the
// app needs to change.
//
// NOTE: the primary intended workflow for this app is MANUAL scorecard
// entry via the admin panel (see matchPlayerController.updateMatchPlayer).
// This provider pipeline is an optional secondary automation path.

import { CricketMatchStats, FootballMatchStats } from "../utils/fantasyScoring";

export interface ExternalPlayerStatLine {
  // Matched to our Player.name (case-insensitive). In a production system,
  // prefer matching on an external player ID stored on the Player row
  // instead of name-matching, which is fragile with spelling variations.
  playerName: string;
  cricketStats?: CricketMatchStats;
  footballStats?: FootballMatchStats;
}

export interface ExternalMatchData {
  isMatchComplete: boolean;
  players: ExternalPlayerStatLine[];
}

export interface SportsDataProvider {
  // externalMatchId: whatever ID the third-party API uses to identify this
  // fixture. Store it on your Match row (see README) once you wire up a
  // real provider.
  fetchMatchStats(externalMatchId: string, sport: "CRICKET" | "FOOTBALL"): Promise<ExternalMatchData>;
}
