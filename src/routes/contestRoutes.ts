import { Router } from "express";
import {
  createContest,
  listContests,
  getContestById,
  joinContest,
  getLeaderboard,
  getMyEntries,
  distributePrizes,
  cancelContest,
} from "../controllers/contestController";
import { requireAuth, requireAdmin } from "../middleware/auth";

const router = Router();

// Public
router.get("/", listContests);
router.get("/:id", getContestById);

// Auth required
// The leaderboard is entrants-only — see the check inside getLeaderboard.
router.get("/:id/leaderboard", requireAuth, getLeaderboard);
router.get("/my/entries", requireAuth, getMyEntries);
router.post("/:id/join", requireAuth, joinContest);

// Admin only
router.post("/", requireAuth, requireAdmin, createContest);
router.post("/:id/distribute-prizes", requireAuth, requireAdmin, distributePrizes);
router.post("/:id/cancel", requireAuth, requireAdmin, cancelContest);

export default router;
