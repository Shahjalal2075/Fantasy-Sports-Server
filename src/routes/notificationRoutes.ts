import { Router } from "express";
import { listNotifications, markNotificationRead } from "../controllers/notificationController";
import { requireAuth } from "../middleware/auth";

const router = Router();

router.use(requireAuth);

router.get("/", listNotifications);
router.patch("/:id/read", markNotificationRead);

export default router;
