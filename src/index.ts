// Local dev / traditional hosting (Render, a VPS, Docker, etc.) entry
// point. NOT used by Vercel — see api/index.ts for the serverless entry,
// which imports the same app from src/app.ts but never calls .listen().
import app from "./app";

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
