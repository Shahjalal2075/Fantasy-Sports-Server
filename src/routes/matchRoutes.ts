import { Router } from "express";
import {
  listMatches,
  getMatchById,
  createMatch,
  updateMatch,
  deleteMatch,
  recalculatePoints,
} from "../controllers/matchController";
import { syncLiveScore } from "../controllers/syncController";
import {
  listMatchPlayers,
  listAvailablePlayers,
  addMatchPlayer,
  updateMatchPlayer,
  removeMatchPlayer,
} from "../controllers/matchPlayerController";
import { listInnings, saveInnings } from "../controllers/inningsController";
import { requireAuth, requireAdmin } from "../middleware/auth";

const router = Router();

// Public — anyone (logged in or not) can browse matches
router.get("/", listMatches);
router.get("/:id", getMatchById);
router.get("/:matchId/players", listMatchPlayers);
// Team scoreboard totals. Public to read — the app shows them above the
// contest leaderboard.
router.get("/:matchId/innings", listInnings);

// Admin only — manage matches
router.post("/", requireAuth, requireAdmin, createMatch);
router.patch("/:id", requireAuth, requireAdmin, updateMatch);
router.delete("/:id", requireAuth, requireAdmin, deleteMatch);
router.post("/:id/calculate-points", requireAuth, requireAdmin, recalculatePoints);
router.post("/:id/sync-live-score", requireAuth, requireAdmin, syncLiveScore);

// Admin only — add/manage players within a match (from the team catalogs)
router.get("/:matchId/available-players", requireAuth, requireAdmin, listAvailablePlayers);
router.put("/:matchId/innings", requireAuth, requireAdmin, saveInnings);
router.post("/:matchId/players", requireAuth, requireAdmin, addMatchPlayer);
router.patch("/:matchId/players/:matchPlayerId", requireAuth, requireAdmin, updateMatchPlayer);
router.delete("/:matchId/players/:matchPlayerId", requireAuth, requireAdmin, removeMatchPlayer);

export default router;
