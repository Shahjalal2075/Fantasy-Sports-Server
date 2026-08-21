import { Router } from "express";
import {
  register,
  login,
  getProfile,
  changePassword,
  updateProfile,
  getReferrals,
  verifyEmail,
  requestOtp,
  resetPassword,
} from "../controllers/authController";
import { requireAuth } from "../middleware/auth";

const router = Router();

router.post("/register", register);
router.post("/login", login);
// Public: all three are used before a user can hold a token.
router.post("/send-otp", requestOtp);
router.post("/verify-email", verifyEmail);
router.post("/reset-password", resetPassword);
router.get("/me", requireAuth, getProfile);
router.patch("/password", requireAuth, changePassword);
router.patch("/profile", requireAuth, updateProfile);
router.get("/referrals", requireAuth, getReferrals);

export default router;
