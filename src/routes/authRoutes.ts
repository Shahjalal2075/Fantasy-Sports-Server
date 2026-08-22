import { Router } from "express";
import {
  register,
  login,
  getProfile,
  changePassword,
  updateProfile,
  getReferrals,
} from "../controllers/authController";
import { requireAuth } from "../middleware/auth";

const router = Router();

router.post("/register", register);
router.post("/login", login);
router.get("/me", requireAuth, getProfile);
router.patch("/password", requireAuth, changePassword);
router.patch("/profile", requireAuth, updateProfile);
router.get("/referrals", requireAuth, getReferrals);

export default router;
