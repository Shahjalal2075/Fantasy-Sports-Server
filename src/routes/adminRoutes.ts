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
  getVisitorAnalytics,
  setUserVerified,
  listCoinAdjustments,
} from "../controllers/adminController";
import {
  listBanners,
  createBanner,
  updateBanner,
  deleteBanner,
} from "../controllers/bannerController";
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
router.get("/analytics/visitors", getVisitorAnalytics);
router.patch("/users/:id/verify", setUserVerified);

// Home-screen banners
router.get("/banners", listBanners);
router.post("/banners", createBanner);
router.patch("/banners/:id", updateBanner);
router.delete("/banners/:id", deleteBanner);
router.get("/coin-adjustments", listCoinAdjustments);

export default router;
