import { Router } from "express";
import {
  listPointSystems,
  getDefaultRules,
  createPointSystem,
  updatePointSystem,
  deletePointSystem,
} from "../controllers/pointSystemController";
import { requireAuth, requireAdmin } from "../middleware/auth";

const router = Router();

router.get("/", listPointSystems);
router.get("/defaults", getDefaultRules);
router.post("/", requireAuth, requireAdmin, createPointSystem);
router.patch("/:id", requireAuth, requireAdmin, updatePointSystem);
router.delete("/:id", requireAuth, requireAdmin, deletePointSystem);

export default router;
