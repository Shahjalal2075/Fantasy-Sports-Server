import { PrismaClient } from "../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// Prisma ORM 7 requires a driver adapter — `new PrismaClient()` with no
// arguments is no longer valid. The generated client also no longer lives
// under "@prisma/client" in node_modules; it's generated straight into
// src/generated/prisma (see the `output` path in prisma/schema.prisma).
//
// SERVERLESS NOTE (Vercel etc.): each function invocation can spin up its
// own connection pool. Without a low `max`, many concurrent invocations
// can exhaust your database's connection limit fast. Default here is a
// conservative `max: 1` per instance — safe for serverless. If you deploy
// to a traditional always-on host (Render, a VPS, Docker) instead, raise
// PRISMA_POOL_MAX (e.g. to 5-10) since there's only ever one process.
// Either way, prefer a POOLED connection string as DATABASE_URL if your
// database provider offers one (e.g. Neon's "-pooler" endpoint, or
// Supabase's connection pooler) — see README "Deploying" section.
const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL!,
  max: Number(process.env.PRISMA_POOL_MAX ?? 1),
});

// Reuse a single PrismaClient instance across the app (avoids exhausting DB connections)
const prisma = new PrismaClient({ adapter });

export default prisma;
