import { Router } from "express";
import { registerPushToken, unregisterPushToken } from "../controllers/pushController";
import { requireAuth } from "../middleware/auth";

const router = Router();

router.use(requireAuth);

router.post("/register", registerPushToken);
router.post("/unregister", unregisterPushToken);

export default router;
