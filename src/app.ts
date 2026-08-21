import "dotenv/config";
import express from "express";
import cors from "cors";
import appConfigRoutes from "./routes/appConfigRoutes";
import authRoutes from "./routes/authRoutes";
import matchRoutes from "./routes/matchRoutes";
import playerRoutes from "./routes/playerRoutes";
import teamRoutes from "./routes/teamRoutes";
import teamEntityRoutes from "./routes/teamEntityRoutes";
import contestRoutes from "./routes/contestRoutes";
import walletRoutes from "./routes/walletRoutes";
import adminRoutes from "./routes/adminRoutes";
import pointSystemRoutes from "./routes/pointSystemRoutes";
import notificationRoutes from "./routes/notificationRoutes";
import promoCodeRoutes from "./routes/promoCodeRoutes";

// Builds and returns the Express app WITHOUT calling .listen(). This is
// shared by both entry points:
//   - src/index.ts   -> local dev / traditional hosting (Render, a VPS, etc.) calls app.listen()
//   - api/index.ts   -> Vercel serverless entry, exports this app directly
//     (Vercel's Node.js runtime treats an Express app as a valid request handler)
const app = express();

// CORS: open by default for easy setup. Once you know your admin panel /
// mobile app's real origins, tighten this via CORS_ORIGIN (comma-separated).
// Guard against CORS_ORIGIN="" (empty string) being treated as a configured
// origin — "".split(",") returns [''], which is truthy and would silently
// block every real origin.
const corsOriginEnv = process.env.CORS_ORIGIN?.trim();
const allowedOrigins = corsOriginEnv ? corsOriginEnv.split(",").map((o) => o.trim()) : undefined;
app.use(cors(allowedOrigins ? { origin: allowedOrigins } : {}));

app.use(express.json());

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "fantasy-sports-backend" });
});

// Routes
app.use("/api/app-config", appConfigRoutes); // public: maintenance, forced update, banner, heartbeat
app.use("/api/auth", authRoutes);
app.use("/api/matches", matchRoutes);
app.use("/api/players", playerRoutes);          // player CATALOG admin CRUD
app.use("/api/teams", teamRoutes);               // fantasy UserTeam (a user's picked 11)
app.use("/api/team-catalog", teamEntityRoutes);  // real-world teams (India, Man Utd, ...)
app.use("/api/contests", contestRoutes);
app.use("/api/wallet", walletRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/point-systems", pointSystemRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/promo-codes", promoCodeRoutes);

export default app;
