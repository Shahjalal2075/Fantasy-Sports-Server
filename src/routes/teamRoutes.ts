import { Router } from "express";
import { createTeam, getMyTeams, getTeamById, deleteTeam } from "../controllers/teamController";
import { requireAuth } from "../middleware/auth";

const router = Router();

// Every team route requires a logged-in user
router.use(requireAuth);

router.post("/", createTeam);
router.get("/my", getMyTeams);
router.get("/:id", getTeamById);
router.delete("/:id", deleteTeam);

export default router;
