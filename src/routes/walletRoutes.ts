import { Router } from "express";
import { getWallet, postClaimDailyBonus, getTransactions } from "../controllers/walletController";
import { requireAuth } from "../middleware/auth";

const router = Router();

router.use(requireAuth);

router.get("/me", getWallet);
router.post("/claim-daily-bonus", postClaimDailyBonus);
router.get("/transactions", getTransactions);

export default router;
