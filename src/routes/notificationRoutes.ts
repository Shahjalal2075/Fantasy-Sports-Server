import { Router } from "express";
import {
  listNotifications,
  markNotificationRead,
  listPopupNotifications,
  ackPopupNotifications,
} from "../controllers/notificationController";
import { requireAuth } from "../middleware/auth";

const router = Router();

router.use(requireAuth);

router.get("/", listNotifications);
// Must precede "/:id/read" so "popups" isn't parsed as an id.
router.get("/popups", listPopupNotifications);
router.post("/popups/ack", ackPopupNotifications);
router.patch("/:id/read", markNotificationRead);

export default router;
