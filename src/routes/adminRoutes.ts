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
  adminResetUserPassword,
  listCoinAdjustments,
} from "../controllers/adminController";
import {
  listBanners,
  createBanner,
  updateBanner,
  deleteBanner,
} from "../controllers/bannerController";
import {
  listGiftRequests,
  approveGiftRequestHandler,
  cancelGiftRequestHandler,
} from "../controllers/giftRequestController";
import {
  listContactMethods,
  createContactMethod,
  updateContactMethod,
} from "../controllers/contactMethodController";
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
router.post("/users/:id/reset-password", adminResetUserPassword);

// Home-screen banners
router.get("/banners", listBanners);
router.post("/banners", createBanner);
router.patch("/banners/:id", updateBanner);
router.delete("/banners/:id", deleteBanner);

// Gift redemption queue
router.get("/gift-requests", listGiftRequests);
router.post("/gift-requests/:id/approve", approveGiftRequestHandler);
router.post("/gift-requests/:id/cancel", cancelGiftRequestHandler);

// Contact methods offered on the gift request form
router.get("/contact-methods", listContactMethods);
router.post("/contact-methods", createContactMethod);
router.patch("/contact-methods/:id", updateContactMethod);
router.get("/coin-adjustments", listCoinAdjustments);

export default router;
