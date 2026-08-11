// Prisma ORM 7 config file. Replaces the old "prisma" key in package.json
// and the datasource `url = env("DATABASE_URL")` line in schema.prisma —
// in v7 the connection string for Migrate/introspection lives here instead.
//
// Migrations should run against a DIRECT (unpooled) connection, not a
// pgbouncer/pooler endpoint — pooled connections can break schema-altering
// statements. If your provider gives you both (e.g. Neon's direct URL vs
// its "-pooler" URL), put the direct one in DIRECT_DATABASE_URL and the
// pooled one in DATABASE_URL (used by the running app, see src/config/prisma.ts).
// If you only have one connection string, both env vars can point to it.
import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    // Falls back to DATABASE_URL if DIRECT_DATABASE_URL isn't set (e.g.
    // you only have one connection string, or you're running locally
    // against a plain Postgres with no pooler in front of it).
    url: process.env.DIRECT_DATABASE_URL ?? env("DATABASE_URL"),
  },
});
