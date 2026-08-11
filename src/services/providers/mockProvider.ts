import { SportsDataProvider, ExternalMatchData } from "../sportsDataProvider";
import prisma from "../../config/prisma";

// Used when no real provider API key is set in .env. Lets you build and
// test the entire sync -> scoring -> leaderboard pipeline end-to-end
// without a paid API subscription. Generates plausible-looking stats for
// the MatchPlayer rows already added to the match.
//
// NOTE: the primary intended workflow for this app is the MANUAL scorecard
// entry (see matchPlayerController.updateMatchPlayer, used by the admin
// panel's Sync Live Score screen). This auto-provider pipeline is kept as
// an optional secondary automation path.
export class MockSportsDataProvider implements SportsDataProvider {
  async fetchMatchStats(
    externalMatchId: string,
    sport: "CRICKET" | "FOOTBALL"
  ): Promise<ExternalMatchData> {
    // externalMatchId is actually our own Match.id in mock mode
    const matchPlayers = await prisma.matchPlayer.findMany({
      where: { matchId: externalMatchId },
      include: { player: true },
    });

    if (sport === "CRICKET") {
      return {
        isMatchComplete: true,
        players: matchPlayers.map((mp) => {
          const runs = Math.floor(Math.random() * 80);
          const ballsFaced = Math.max(runs > 0 ? Math.ceil(runs / 1.3) : 0, runs > 0 ? 5 : 0);
          return {
            playerName: mp.player.name,
            cricketStats: {
              isPlaying: mp.isPlaying,
              runs,
              fours: Math.floor(runs / 10),
              sixes: Math.floor(runs / 25),
              ballsFaced,
              isOut: runs === 0 ? Math.random() > 0.5 : Math.random() > 0.3,
              wickets: mp.player.role === "BOWL" || mp.player.role === "AR" ? Math.floor(Math.random() * 4) : 0,
              wicketsBowledOrLBW: 0,
              maidens: 0,
              dotBalls: mp.player.role === "BOWL" || mp.player.role === "AR" ? Math.floor(Math.random() * 10) : 0,
              catches: Math.random() > 0.7 ? 1 : 0,
              stumpings: mp.player.role === "WK" && Math.random() > 0.8 ? 1 : 0,
              runOutsDirect: 0,
              runOutsIndirect: 0,
              ballsBowled: mp.player.role === "BOWL" || mp.player.role === "AR" ? 24 : 0,
              runsConceded: mp.player.role === "BOWL" || mp.player.role === "AR" ? Math.floor(Math.random() * 40) : 0,
            },
          };
        }),
      };
    }

      return {
        isMatchComplete: true,
        players: matchPlayers.map((mp) => ({
          playerName: mp.player.name,
          footballStats: {
            isPlaying: mp.isPlaying,
            minutesPlayed: Math.random() > 0.15 ? 90 : Math.floor(Math.random() * 89),
            goals: mp.player.role === "FWD" ? Math.floor(Math.random() * 2) : 0,
            assists: Math.random() > 0.8 ? 1 : 0,
            cleanSheet: (mp.player.role === "GK" || mp.player.role === "DEF") && Math.random() > 0.5,
            yellowCards: Math.random() > 0.85 ? 1 : 0,
            redCards: 0,
            ownGoals: 0,
            penaltiesSaved: mp.player.role === "GK" && Math.random() > 0.9 ? 1 : 0,
            penaltiesMissed: 0,
            saves: mp.player.role === "GK" ? Math.floor(Math.random() * 6) : 0,
          },
        })),
      };
  }
}
