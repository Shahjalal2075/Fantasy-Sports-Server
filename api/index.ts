// Vercel serverless entry point. Vercel's Node.js runtime can adapt an
// Express app directly (it has the same (req, res) => void shape Vercel
// expects) — no app.listen() needed or wanted here; Vercel manages the
// actual request lifecycle itself.
//
// vercel.json rewrites EVERY request path to this function, so Express
// still sees the original full path (e.g. /api/auth/login) on req.url and
// routes it exactly like it would locally.
import app from "../src/app";

export default app;
