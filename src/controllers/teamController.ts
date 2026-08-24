import { Request, Response } from "express";
import prisma from "../config/prisma";
import { createTeamSchema, updateTeamSchema } from "../utils/validators";
import { validateTeamSelection, MAX_TEAMS_PER_MATCH } from "../utils/teamRules";
import { getCaptainMultipliers } from "../services/pointsService";

// Team names are generated, never user-supplied: "Shahjalal (T1)",
// "Shahjalal (T2)"… We pick the lowest free slot rather than
// (count + 1) so that deleting T1 and creating again reuses T1 instead
// of colliding with an existing T2 on the (userId, matchId, teamName)
// unique constraint.
function nextTeamName(username: string, existingNames: string[]): string {
  const used = new Set<number>();
  for (const name of existingNames) {
    const match = name.match(/\(T(\d+)\)$/);
    if (match) used.add(Number(match[1]));
  }
  let slot = 1;
  while (used.has(slot)) slot += 1;
  return `${username} (T${slot})`;
}

// Shared by create + update: resolves the MatchPlayer rows and runs every
// roster rule against them. Returns either an error response payload or
// the validated rows.
async function resolveAndValidate(
  matchId: string,
  matchPlayerIds: string[],
  captainId: string,
  viceCaptainId: string
): Promise<{ status: number; body: Record<string, unknown> } | null> {
  const match = await prisma.match.findUnique({ where: { id: matchId } });
  if (!match) {
    return { status: 404, body: { error: "Match not found" } };
  }

  // Team selection closes at lockTime — usually kickoff/first-ball time.
  // This is also what stops a user who started editing before lock from
  // saving after it: the save simply fails and their last saved XI stands.
  if (new Date() >= match.lockTime) {
    return { status: 400, body: { error: "Team selection is locked for this match" } };
  }

  // Fetch the actual MatchPlayer rows (+ their catalog Player) so we
  // validate against real data, not client-supplied values.
  const matchPlayers = await prisma.matchPlayer.findMany({
    where: { id: { in: matchPlayerIds }, matchId },
    include: { player: true },
  });

  if (matchPlayers.length !== matchPlayerIds.length) {
    return { status: 400, body: { error: "One or more selected players do not belong to this match" } };
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
    return { status: 400, body: { error: "Invalid team selection", details: validation.errors } };
  }

  return null;
}

const TEAM_INCLUDE = {
  players: { include: { matchPlayer: { include: { player: { include: { team: true } } } } } },
} as const;

// POST /api/teams  (auth required)
export async function createTeam(req: Request, res: Response) {
  const parsed = createTeamSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const { matchId, matchPlayerIds, captainId, viceCaptainId } = parsed.data;
  const userId = req.userId as string;

  const failure = await resolveAndValidate(matchId, matchPlayerIds, captainId, viceCaptainId);
  if (failure) {
    return res.status(failure.status).json(failure.body);
  }

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { username: true } });
  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }

  const existing = await prisma.userTeam.findMany({
    where: { userId, matchId },
    select: { teamName: true },
  });

  if (existing.length >= MAX_TEAMS_PER_MATCH) {
    return res.status(400).json({
      error: `You can create at most ${MAX_TEAMS_PER_MATCH} teams for one match`,
    });
  }

  const teamName = nextTeamName(user.username, existing.map((t) => t.teamName));

  try {
    const userTeam = await prisma.$transaction(async (tx) => {
      const team = await tx.userTeam.create({
        data: { userId, matchId, teamName, captainId, viceCaptainId },
      });

      await tx.userTeamPlayer.createMany({
        data: matchPlayerIds.map((matchPlayerId) => ({ userTeamId: team.id, matchPlayerId })),
      });

      return tx.userTeam.findUnique({ where: { id: team.id }, include: TEAM_INCLUDE });
    });

    return res.status(201).json({ userTeam });
  } catch (err: any) {
    if (err.code === "P2002") {
      // Two saves raced for the same generated slot — harmless, retryable.
      return res.status(409).json({ error: "Couldn't allocate a team slot — please try again" });
    }
    throw err;
  }
}

// PUT /api/teams/:id  (auth required) — replace an existing team's XI and
// captain/VC. Used by My Teams -> edit (5.jpg). The team's name and match
// are fixed; only the selection changes.
export async function updateTeam(req: Request, res: Response) {
  const { id } = req.params as { id: string };
  const userId = req.userId as string;

  const parsed = updateTeamSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }
  const { matchPlayerIds, captainId, viceCaptainId } = parsed.data;

  const existing = await prisma.userTeam.findUnique({ where: { id } });
  if (!existing) {
    return res.status(404).json({ error: "Team not found" });
  }
  if (existing.userId !== userId) {
    return res.status(403).json({ error: "You do not have access to this team" });
  }

  const failure = await resolveAndValidate(existing.matchId, matchPlayerIds, captainId, viceCaptainId);
  if (failure) {
    return res.status(failure.status).json(failure.body);
  }

  const userTeam = await prisma.$transaction(async (tx) => {
    // Swap the whole XI rather than diffing — simpler and the row count
    // is fixed at 11.
    await tx.userTeamPlayer.deleteMany({ where: { userTeamId: id } });
    await tx.userTeamPlayer.createMany({
      data: matchPlayerIds.map((matchPlayerId) => ({ userTeamId: id, matchPlayerId })),
    });
    await tx.userTeam.update({ where: { id }, data: { captainId, viceCaptainId } });

    return tx.userTeam.findUnique({ where: { id }, include: TEAM_INCLUDE });
  });

  return res.status(200).json({ userTeam });
}

// Any team's per-player point breakdown is hidden until the match has
// been live for this long. Before the window opens, showing a rival's XI
// would leak their selection while teams can still be built.
const BREAKDOWN_DELAY_MS = 5 * 60 * 1000;

// GET /api/teams/:id/breakdown  (auth required)
// Unlike GET /api/teams/:id this is deliberately NOT owner-only — it's
// what the contest leaderboard (7.jpg) opens when you tap any entry
// (8.jpg). Access is gated on the match clock instead of ownership.
export async function getTeamBreakdown(req: Request, res: Response) {
  const { id } = req.params as { id: string };

  const userTeam = await prisma.userTeam.findUnique({
    where: { id },
    include: {
      match: true,
      user: { select: { id: true, name: true, username: true } },
      players: { include: { matchPlayer: { include: { player: { include: { team: true } } } } } },
    },
  });

  if (!userTeam) {
    return res.status(404).json({ error: "Team not found" });
  }

  const match = userTeam.match;
  const isOwner = userTeam.userId === req.userId;

  // The match clock, not the stored status, decides: the DB row stays
  // UPCOMING until an admin closes it, but play starts at lockTime.
  const liveSince = match.lockTime.getTime();
  const windowOpen =
    match.status === "COMPLETED" ||
    (match.status !== "CANCELLED" && Date.now() >= liveSince + BREAKDOWN_DELAY_MS);

  // Admins can always inspect any team — they need it to review a
  // lineup from the leaderboard and to check scoring before paying out.
  const viewer = await prisma.user.findUnique({
    where: { id: req.userId as string },
    select: { isAdmin: true },
  });

  // Owners can always inspect their own team (that's My Teams -> eye).
  if (!windowOpen && !isOwner && !viewer?.isAdmin) {
    return res.status(403).json({
      error: "Point breakdowns open a few minutes after the match goes live",
      availableAt: new Date(liveSince + BREAKDOWN_DELAY_MS),
    });
  }

  const { captainMultiplier, viceCaptainMultiplier } = await getCaptainMultipliers(
    match.sport,
    match.format
  );

  const players = userTeam.players.map((entry) => {
    const mp = entry.matchPlayer;
    const multiplier =
      mp.id === userTeam.captainId
        ? captainMultiplier
        : mp.id === userTeam.viceCaptainId
          ? viceCaptainMultiplier
          : 1;

    return {
      matchPlayerId: mp.id,
      name: mp.player.name,
      role: mp.player.role,
      teamShortName: mp.player.team?.shortName ?? "",
      hasPhoto: mp.player.hasPhoto,
      imageUrl: mp.player.imageUrl,
      isPlaying: mp.isPlaying,
      // Base points before the captain/VC bump…
      points: mp.points,
      multiplier,
      // …and after, which is what feeds UserTeam.totalPoints.
      effectivePoints: mp.points * multiplier,
      isCaptain: mp.id === userTeam.captainId,
      isViceCaptain: mp.id === userTeam.viceCaptainId,
    };
  });

  return res.status(200).json({
    breakdown: {
      userTeamId: userTeam.id,
      teamName: userTeam.teamName,
      userName: userTeam.user.username,
      matchId: match.id,
      sport: match.sport,
      totalPoints: userTeam.totalPoints,
      captainMultiplier,
      viceCaptainMultiplier,
      players,
    },
  });
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
    include: TEAM_INCLUDE,
    // Oldest first so T1 stays at the top of My Teams as teams are added.
    orderBy: { createdAt: "asc" },
  });

  return res.status(200).json({ userTeams, maxTeamsPerMatch: MAX_TEAMS_PER_MATCH });
}

// GET /api/teams/:id  (auth required) — detail view; only the owner can view it
export async function getTeamById(req: Request, res: Response) {
  const { id } = req.params as { id: string };
  const userId = req.userId as string;

  const userTeam = await prisma.userTeam.findUnique({
    where: { id },
    include: { ...TEAM_INCLUDE, match: true },
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
