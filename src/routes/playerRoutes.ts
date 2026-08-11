import { Router } from "express";
import { createPlayer, updatePlayer, deletePlayer } from "../controllers/playerController";
import { requireAuth, requireAdmin } from "../middleware/auth";

const router = Router();

// All player-catalog management is admin-only.
// (Public listing lives under /api/team-catalog/:teamId/players)
router.post("/", requireAuth, requireAdmin, createPlayer);
router.patch("/:id", requireAuth, requireAdmin, updatePlayer);
router.delete("/:id", requireAuth, requireAdmin, deletePlayer);

export default router;
