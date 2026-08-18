import { Router } from "express";
import {
  listPromoCodes,
  createPromoCode,
  updatePromoCode,
  deletePromoCode,
  claimPromoCode,
} from "../controllers/promoCodeController";
import { requireAuth, requireAdmin } from "../middleware/auth";

const router = Router();

router.post("/claim", requireAuth, claimPromoCode);

router.get("/", requireAuth, requireAdmin, listPromoCodes);
router.post("/", requireAuth, requireAdmin, createPromoCode);
router.patch("/:id", requireAuth, requireAdmin, updatePromoCode);
router.delete("/:id", requireAuth, requireAdmin, deletePromoCode);

export default router;
