import { Router } from "express";
import {
  getGiftConfig,
  submitGiftRequest,
  getMyGiftRequests,
} from "../controllers/giftRequestController";
import { requireAuth } from "../middleware/auth";

const router = Router();

router.use(requireAuth);

router.get("/config", getGiftConfig);
router.get("/my", getMyGiftRequests);
router.post("/", submitGiftRequest);

export default router;
