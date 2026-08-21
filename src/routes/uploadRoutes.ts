import { Router } from "express";
import { uploadImage } from "../controllers/uploadController";
import { requireAuth } from "../middleware/auth";

const router = Router();

// Auth-only: an open upload proxy would let anyone burn through the
// imgbb quota attached to this key.
router.post("/image", requireAuth, uploadImage);

export default router;
