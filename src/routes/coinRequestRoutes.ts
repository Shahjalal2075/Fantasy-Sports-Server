import { Router } from "express";
import {
  getCoinRequestConfig,
  myCoinRequests,
  previewCouponHandler,
  submitCoinRequest,
} from "../controllers/coinRequestController";
import { requireAuth } from "../middleware/auth";

const router = Router();

router.use(requireAuth);

router.get("/config", getCoinRequestConfig);
router.get("/my", myCoinRequests);
router.post("/preview-coupon", previewCouponHandler);
router.post("/", submitCoinRequest);

export default router;
