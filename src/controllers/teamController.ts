import { Request, Response } from "express";
import prisma from "../config/prisma";
import { createTeamSchema } from "../utils/validators";
import { validateTeamSelection } from "../utils/teamRules";

// POST /api/teams  (auth required)
export async function createTeam(req: Request, res: Response) {
  const parsed = createTeamSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const { matchId, teamName, matchPlayerIds, captainId, viceCaptainId } = parsed.data;
  const userId = req.userId as string;

  const match = await prisma.match.findUnique({ where: { id: matchId } });
  if (!match) {
    return res.status(404).json({ error: "Match not found" });
  }

  // Team selection closes at lockTime — usually kickoff/first-ball time
  if (new Date() >= match.lockTime) {
    return res.status(400).json({ error: "Team selection is locked for this match" });
  }

  // Fetch the actual MatchPlayer rows (+ their catalog Player) so we
  // validate against real data, not client-supplied values.
  const matchPlayers = await prisma.matchPlayer.findMany({
    where: { id: { in: matchPlayerIds }, matchId },
    include: { player: true },
  });

  if (matchPlayers.length !== matchPlayerIds.length) {
    return res.status(400).json({ error: "One or more selected players do not belong to this match" });
  }

  const matchTeams = await prisma.team.findMany({
    where: { id: { in: [match.teamAId, match.teamBId] } },
  });
  const teamNames = Object.fromEntries(matchTeams.map((t) => [t.id, t.name]));

  const validation = validateTeamSelection(
    match.sport,
    matchPlayers.map((mp) => ({
      id: mp.id,
      teamId: mp.player.teamId,
      role: mp.player.role,
      creditValue: mp.player.creditValue,
      isPlaying: mp.isPlaying,
    })),
    captainId,
    viceCaptainId,
    teamNames
  );
  if (!validation.valid) {
    return res.status(400).json({ error: "Invalid team selection", details: validation.errors });
  }

  try {
    const userTeam = await prisma.$transaction(async (tx) => {
      const team = await tx.userTeam.create({
        data: {
          userId,
          matchId,
          teamName: teamName ?? "My Team",
          captainId,
          viceCaptainId,
        },
      });

      await tx.userTeamPlayer.createMany({
        data: matchPlayerIds.map((matchPlayerId) => ({
          userTeamId: team.id,
          matchPlayerId,
        })),
      });

      return tx.userTeam.findUnique({
        where: { id: team.id },
        include: { players: { include: { matchPlayer: { include: { player: true } } } } },
      });
    });

    return res.status(201).json({ userTeam });
  } catch (err: any) {
    if (err.code === "P2002") {
      return res.status(409).json({ error: "You already have a team with this name for this match" });
    }
    throw err;
  }
}

// GET /api/teams/my?matchId=  (auth required) — list the logged-in user's teams
export async function getMyTeams(req: Request, res: Response) {
  const userId = req.userId as string;
  const { matchId } = req.query;

  const userTeams = await prisma.userTeam.findMany({
    where: {
      userId,
      matchId: matchId ? (matchId as string) : undefined,
    },
    include: { players: { include: { matchPlayer: { include: { player: true } } } } },
    orderBy: { createdAt: "desc" },
  });

  return res.status(200).json({ userTeams });
}

// GET /api/teams/:id  (auth required) — detail view; only the owner can view it
export async function getTeamById(req: Request, res: Response) {
  const { id } = req.params as { id: string };
  const userId = req.userId as string;

  const userTeam = await prisma.userTeam.findUnique({
    where: { id },
    include: { players: { include: { matchPlayer: { include: { player: true } } } }, match: true },
  });

  if (!userTeam) {
    return res.status(404).json({ error: "Team not found" });
  }

  if (userTeam.userId !== userId) {
    return res.status(403).json({ error: "You do not have access to this team" });
  }

  return res.status(200).json({ userTeam });
}

// DELETE /api/teams/:id  (auth required) — allowed only before the match locks
export async function deleteTeam(req: Request, res: Response) {
  const { id } = req.params as { id: string };
  const userId = req.userId as string;

  const userTeam = await prisma.userTeam.findUnique({
    where: { id },
    include: { match: true },
  });

  if (!userTeam) {
    return res.status(404).json({ error: "Team not found" });
  }
  if (userTeam.userId !== userId) {
    return res.status(403).json({ error: "You do not have access to this team" });
  }
  if (new Date() >= userTeam.match.lockTime) {
    return res.status(400).json({ error: "Cannot delete a team after selection has locked" });
  }

  await prisma.userTeam.delete({ where: { id } });

  return res.status(200).json({ message: "Team deleted" });
}
