import { Router } from "express";
import {
  createContest,
  listContests,
  getContestById,
  joinContest,
  getLeaderboard,
  getMyEntries,
  distributePrizes,
} from "../controllers/contestController";
import { requireAuth, requireAdmin } from "../middleware/auth";

const router = Router();

// Public
router.get("/", listContests);
router.get("/:id", getContestById);
router.get("/:id/leaderboard", getLeaderboard);

// Auth required
router.get("/my/entries", requireAuth, getMyEntries);
router.post("/:id/join", requireAuth, joinContest);

// Admin only
router.post("/", requireAuth, requireAdmin, createContest);
router.post("/:id/distribute-prizes", requireAuth, requireAdmin, distributePrizes);

export default router;
