import { Router } from "express";
import {
  listUsers,
  giveBonus,
  giveFine,
  banUser,
  unbanUser,
  getSettings,
  updateSettings,
} from "../controllers/adminController";
import { requireAuth, requireAdmin } from "../middleware/auth";

const router = Router();

router.use(requireAuth, requireAdmin);

router.get("/users", listUsers);
router.post("/users/:id/bonus", giveBonus);
router.post("/users/:id/fine", giveFine);
router.post("/users/:id/ban", banUser);
router.post("/users/:id/unban", unbanUser);
router.get("/settings", getSettings);
router.patch("/settings", updateSettings);

export default router;
