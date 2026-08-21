import { Router } from "express";
import {
  register,
  login,
  getProfile,
  changePassword,
  updateProfile,
} from "../controllers/authController";
import { requireAuth } from "../middleware/auth";

const router = Router();

router.post("/register", register);
router.post("/login", login);
router.get("/me", requireAuth, getProfile);
router.patch("/password", requireAuth, changePassword);
router.patch("/profile", requireAuth, updateProfile);

export default router;
