import { Router } from "express";
import {
  createTeam,
  updateTeam,
  getMyTeams,
  getTeamById,
  getTeamBreakdown,
  deleteTeam,
} from "../controllers/teamController";
import { requireAuth } from "../middleware/auth";

const router = Router();

// Every team route requires a logged-in user
router.use(requireAuth);

router.post("/", createTeam);
router.get("/my", getMyTeams);
// Must come before "/:id" so it isn't swallowed by the id param.
router.get("/:id/breakdown", getTeamBreakdown);
router.get("/:id", getTeamById);
router.put("/:id", updateTeam);
router.delete("/:id", deleteTeam);

export default router;
