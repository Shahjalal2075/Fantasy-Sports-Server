import { Router } from "express";
import { liveConnect, liveScore } from "../controllers/liveSyncController";
import { requireLiveSyncKey } from "../middleware/liveSyncAuth";

const router = Router();

// Every route here is machine-to-machine, keyed rather than logged in.
router.use(requireLiveSyncKey);

router.post("/connect", liveConnect);
router.post("/score", liveScore);

export default router;
