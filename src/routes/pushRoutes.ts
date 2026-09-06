import { Router } from "express";
import {
  registerToken,
  unregisterToken,
  setPushPreference,
} from "../controllers/pushController";
import { requireAuth } from "../middleware/auth";

const router = Router();

router.use(requireAuth);

router.post("/register", registerToken);
router.delete("/register", unregisterToken);
router.patch("/preference", setPushPreference);

export default router;
