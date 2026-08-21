import { Router } from "express";
import { getAppConfig, postHeartbeat } from "../controllers/appConfigController";
import { optionalAuth } from "../middleware/auth";

const router = Router();

// Both routes are public on purpose — the app calls them before login so
// that maintenance mode and forced updates can block the launch screen.
router.get("/", optionalAuth, getAppConfig);
router.post("/heartbeat", optionalAuth, postHeartbeat);

export default router;
