// Seeds sensible defaults so the app is usable immediately after first
// migration: PointSystem rows for all 5 built-in cricket formats (T20,
// ODI, Test, T10, H100 — matching the provided scoring sheet exactly) plus
// a football default, and default app settings. Prisma ORM 7 no longer
// auto-runs this after `migrate dev` — run it explicitly with
// `npm run prisma:seed`.
import prisma from "../src/config/prisma";
import {
  DEFAULT_CRICKET_RULES_T20,
  DEFAULT_CRICKET_RULES_ODI,
  DEFAULT_CRICKET_RULES_TEST,
  DEFAULT_CRICKET_RULES_T10,
  DEFAULT_CRICKET_RULES_H100,
  DEFAULT_FOOTBALL_RULES,
} from "../src/utils/fantasyScoring";

async function main() {
  await prisma.appSettings.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1, dailyBonusAmount: 100 },
  });
  console.log("✅ App settings seeded (dailyBonusAmount = 100)");

  const cricketFormats: [string, boolean, unknown][] = [
    ["T20", true, DEFAULT_CRICKET_RULES_T20], // T20 is the default cricket format
    ["ODI", false, DEFAULT_CRICKET_RULES_ODI],
    ["Test", false, DEFAULT_CRICKET_RULES_TEST],
    ["T10", false, DEFAULT_CRICKET_RULES_T10],
    ["H100", false, DEFAULT_CRICKET_RULES_H100],
  ];

  for (const [format, isDefault, rules] of cricketFormats) {
    await prisma.pointSystem.upsert({
      where: { sport_format: { sport: "CRICKET", format } },
      update: {},
      create: { sport: "CRICKET", format, isDefault, rules: rules as any },
    });
  }
  console.log("✅ Cricket point systems seeded: T20 (default), ODI, Test, T10, H100");

  await prisma.pointSystem.upsert({
    where: { sport_format: { sport: "FOOTBALL", format: "Default" } },
    update: {},
    create: { sport: "FOOTBALL", format: "Default", isDefault: true, rules: DEFAULT_FOOTBALL_RULES as any },
  });
  console.log("✅ Football point system seeded (Default)");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => process.exit(0));
