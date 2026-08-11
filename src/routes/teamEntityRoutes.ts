import { Router } from "express";
import {
  listTeamEntities,
  createTeamEntity,
  updateTeamEntity,
  deleteTeamEntity,
  getTeamPlayers,
  getTeamRecentMatches,
} from "../controllers/teamEntityController";
import { requireAuth, requireAdmin } from "../middleware/auth";

const router = Router();

// Public — needed to populate team dropdowns and the Team Detail Mode tabs
router.get("/", listTeamEntities);
router.get("/:id/players", getTeamPlayers);
router.get("/:id/recent-matches", getTeamRecentMatches);

// Admin only
router.post("/", requireAuth, requireAdmin, createTeamEntity);
router.patch("/:id", requireAuth, requireAdmin, updateTeamEntity);
router.delete("/:id", requireAuth, requireAdmin, deleteTeamEntity);

export default router;
