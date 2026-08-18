import { Router } from "express";
import {
  listUsers,
  getUserDetail,
  giveBonus,
  giveFine,
  banUser,
  unbanUser,
  getSettings,
  updateSettings,
  listCoinAdjustments,
} from "../controllers/adminController";
import { requireAuth, requireAdmin } from "../middleware/auth";

const router = Router();

router.use(requireAuth, requireAdmin);

router.get("/users", listUsers);
router.get("/users/:id", getUserDetail);
router.post("/users/:id/bonus", giveBonus);
router.post("/users/:id/fine", giveFine);
router.post("/users/:id/ban", banUser);
router.post("/users/:id/unban", unbanUser);
router.get("/settings", getSettings);
router.patch("/settings", updateSettings);
router.get("/coin-adjustments", listCoinAdjustments);

export default router;
