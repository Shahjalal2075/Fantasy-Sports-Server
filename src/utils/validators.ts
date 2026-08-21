import { z } from "zod";

export const registerSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters"),
  username: z
    .string()
    .min(3, "Username must be at least 3 characters")
    .max(20, "Username must be at most 20 characters")
    .regex(/^[a-zA-Z0-9_.]+$/, "Username can only contain letters, numbers, underscores, and periods"),
  email: z.string().email("Invalid email address"),
  phone: z.string().min(10).max(15).optional(),
  password: z.string().min(6, "Password must be at least 6 characters"),
  referralCode: z.string().max(30).optional(),
});

export const loginSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;

export const createMatchSchema = z.object({
  sport: z.enum(["CRICKET", "FOOTBALL"]),
  teamAId: z.string().uuid(),
  teamBId: z.string().uuid(),
  tournamentName: z.string().min(1),
  format: z.string().min(1),
  venue: z.string().optional(),
  startTime: z.string().datetime({ message: "startTime must be an ISO date string" }),
  lockTime: z.string().datetime({ message: "lockTime must be an ISO date string" }).optional(),
}).refine((data) => data.teamAId !== data.teamBId, {
  message: "Team A and Team B must be different teams",
  path: ["teamBId"],
});

export const updateMatchSchema = z.object({
  sport: z.enum(["CRICKET", "FOOTBALL"]).optional(),
  teamAId: z.string().uuid().optional(),
  teamBId: z.string().uuid().optional(),
  tournamentName: z.string().min(1).optional(),
  format: z.string().min(1).optional(),
  venue: z.string().optional(),
  startTime: z.string().datetime({ message: "startTime must be an ISO date string" }).optional(),
  lockTime: z.string().datetime({ message: "lockTime must be an ISO date string" }).optional(),
  status: z.enum(["UPCOMING", "LIVE", "COMPLETED", "CANCELLED"]).optional(),
});

export type CreateMatchInput = z.infer<typeof createMatchSchema>;
export type UpdateMatchInput = z.infer<typeof updateMatchSchema>;

export const createTeamEntitySchema = z
  .object({
    name: z.string().min(1).max(60),
    shortName: z.string().min(1).max(10),
    sport: z.enum(["CRICKET", "FOOTBALL"]),
    hasLogo: z.boolean().optional(),
    logoUrl: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.hasLogo) {
      if (!data.logoUrl || !z.string().url().safeParse(data.logoUrl).success) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "logoUrl must be a valid URL when hasLogo is true" });
      }
    }
  });

export const updateTeamEntitySchema = z
  .object({
    name: z.string().min(1).max(60).optional(),
    shortName: z.string().min(1).max(10).optional(),
    sport: z.enum(["CRICKET", "FOOTBALL"]).optional(),
    hasLogo: z.boolean().optional(),
    logoUrl: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.hasLogo) {
      if (!data.logoUrl || !z.string().url().safeParse(data.logoUrl).success) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "logoUrl must be a valid URL when hasLogo is true" });
      }
    }
  });

export type CreateTeamEntityInput = z.infer<typeof createTeamEntitySchema>;
export type UpdateTeamEntityInput = z.infer<typeof updateTeamEntitySchema>;

// NOTE: there is deliberately no `teamName` here. Team names are not
// user-editable — the server generates them as "Username (T1)", "(T2)"…
// so they stay unique per match and can't be spoofed.
export const createTeamSchema = z.object({
  matchId: z.string().uuid(),
  matchPlayerIds: z.array(z.string().uuid()).length(11, "You must select exactly 11 players"),
  captainId: z.string().uuid(), // one of matchPlayerIds
  viceCaptainId: z.string().uuid(), // one of matchPlayerIds
});

export type CreateTeamInput = z.infer<typeof createTeamSchema>;

// Editing an existing team replaces the whole XI + captain/VC. The team's
// match and name never change, so neither is accepted here.
export const updateTeamSchema = z.object({
  matchPlayerIds: z.array(z.string().uuid()).length(11, "You must select exactly 11 players"),
  captainId: z.string().uuid(),
  viceCaptainId: z.string().uuid(),
});

export type UpdateTeamInput = z.infer<typeof updateTeamSchema>;

export const prizeDistributionEntrySchema = z.object({
  rank: z.number().int().min(1),
  coins: z.number().int().min(1),
});

export const createContestSchema = z
  .object({
    matchId: z.string().uuid(),
    name: z.string().min(1).max(60),
    maxEntries: z.number().int().min(2).max(1000000).optional(),
    entryCost: z.number().int().min(0).optional(), // coins to join; no cap
    prizeDistribution: z.array(prizeDistributionEntrySchema).max(50).optional(),
  })
  .superRefine((data, ctx) => {
    if (!data.prizeDistribution || data.prizeDistribution.length === 0) return;
    const ranks = data.prizeDistribution.map((p) => p.rank).sort((a, b) => a - b);
    // Ranks must be 1, 2, 3, ... with no gaps or duplicates
    for (let i = 0; i < ranks.length; i++) {
      if (ranks[i] !== i + 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "prizeDistribution ranks must start at 1 and be sequential with no gaps or duplicates",
        });
        break;
      }
    }
  });

export type CreateContestInput = z.infer<typeof createContestSchema>;

export const joinContestSchema = z.object({
  userTeamId: z.string().uuid(),
});

export type JoinContestInput = z.infer<typeof joinContestSchema>;

export const createPointSystemSchema = z.object({
  sport: z.enum(["CRICKET", "FOOTBALL"]),
  format: z.string().min(1),
  isDefault: z.boolean().optional(),
  // Shape differs cricket vs football (see CricketPointRules / FootballPointRules
  // in fantasyScoring.ts) and includes nested arrays (milestones, rate bands),
  // so we validate it's a plain object here and trust the admin panel's form
  // to construct a correct shape — the calculation engine treats missing
  // fields as "not configured" (empty arrays / 0) rather than crashing.
  rules: z.record(z.string(), z.any()),
});

export const updatePointSystemSchema = z.object({
  format: z.string().min(1).optional(),
  isDefault: z.boolean().optional(),
  rules: z.record(z.string(), z.any()).optional(),
});

export type CreatePointSystemInput = z.infer<typeof createPointSystemSchema>;
export type UpdatePointSystemInput = z.infer<typeof updatePointSystemSchema>;

// ---- Player CATALOG (belongs to a Team, reused across matches) ----
export const createCatalogPlayerSchema = z
  .object({
    teamId: z.string().uuid(),
    name: z.string().min(1),
    role: z.string().min(1),
    creditValue: z.number().min(1).max(15).optional(),
    hasPhoto: z.boolean().optional(),
    imageUrl: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.hasPhoto) {
      if (!data.imageUrl || !z.string().url().safeParse(data.imageUrl).success) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "imageUrl must be a valid URL when hasPhoto is true" });
      }
    }
  });

export const updateCatalogPlayerSchema = z
  .object({
    teamId: z.string().uuid().optional(),
    name: z.string().min(1).optional(),
    role: z.string().min(1).optional(),
    creditValue: z.number().min(1).max(15).optional(),
    hasPhoto: z.boolean().optional(),
    imageUrl: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.hasPhoto) {
      if (!data.imageUrl || !z.string().url().safeParse(data.imageUrl).success) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "imageUrl must be a valid URL when hasPhoto is true" });
      }
    }
  });

// ---- MatchPlayer (a catalog Player's participation in one Match) ----
export const addMatchPlayerSchema = z.object({
  playerId: z.string().uuid(),
});

export const updateMatchPlayerSchema = z.object({
  isPlaying: z.boolean().optional(),
  // Cricket
  runs: z.number().int().min(0).optional(),
  ballsFaced: z.number().int().min(0).optional(),
  fours: z.number().int().min(0).optional(),
  sixes: z.number().int().min(0).optional(),
  isOut: z.boolean().optional(),
  ballsBowled: z.number().int().min(0).optional(),
  dotBalls: z.number().int().min(0).optional(),
  maidens: z.number().int().min(0).optional(),
  runsConceded: z.number().int().min(0).optional(),
  wickets: z.number().int().min(0).optional(),
  wicketsBowledOrLBW: z.number().int().min(0).optional(),
  catches: z.number().int().min(0).optional(),
  runOutsDirect: z.number().int().min(0).optional(),
  runOutsIndirect: z.number().int().min(0).optional(),
  stumpings: z.number().int().min(0).optional(),
  // Football
  minutesPlayed: z.number().int().min(0).max(120).optional(),
  goals: z.number().int().min(0).optional(),
  assists: z.number().int().min(0).optional(),
  cleanSheet: z.boolean().optional(),
  yellowCards: z.number().int().min(0).optional(),
  redCards: z.number().int().min(0).optional(),
  ownGoals: z.number().int().min(0).optional(),
  penaltiesSaved: z.number().int().min(0).optional(),
  penaltiesMissed: z.number().int().min(0).optional(),
  saves: z.number().int().min(0).optional(),
});

// ---- Admin: coin bonus/fine, ban, settings ----
export const coinAdjustmentSchema = z.object({
  amount: z.number().int().min(1).max(100000),
  reason: z.string().min(1).max(300),
});

export const banUserSchema = z.object({
  reason: z.string().min(1).max(300).optional(),
});

// Dotted numeric version like "1.4.2" — the server compares these part
// by part, so anything else would silently sort wrong.
const versionString = z
  .string()
  .regex(/^\d+(\.\d+)*$/, "Version must look like 1.4.2");

// Every field is optional so the admin panel can PATCH one section (say,
// just maintenance mode) without resending the whole settings object.
export const updateSettingsSchema = z
  .object({
    dailyBonusAmount: z.number().int().min(0).max(100000).optional(),

    referralSignupBonus: z.number().int().min(0).max(100000).optional(),
    referralInviterBonus: z.number().int().min(0).max(100000).optional(),

    // Generous cap — these are full legal documents, not blurbs.
    privacyPolicy: z.string().max(50000).optional(),
    termsAndConditions: z.string().max(50000).optional(),

    maintenanceMode: z.boolean().optional(),
    maintenanceMessage: z.string().max(500).optional(),

    latestAppVersion: versionString.optional(),
    minSupportedVersion: versionString.optional(),
    updateUrl: z.string().url().or(z.literal("")).optional(),
    updateMessage: z.string().max(500).optional(),

    supportEmail: z.string().email().or(z.literal("")).optional(),
    supportPhone: z.string().max(30).optional(),
    supportWhatsapp: z.string().max(30).optional(),
    supportFacebook: z.string().url().or(z.literal("")).optional(),
    supportHours: z.string().max(120).optional(),
  })
  // Banners moved to their own endpoints (/api/admin/banners), so there's
  // nothing left here that needs cross-field validation.
  ;

export const createPromoCodeSchema = z.object({
  code: z
    .string()
    .min(3, "Code must be at least 3 characters")
    .max(30)
    .regex(/^[a-zA-Z0-9_-]+$/, "Code can only contain letters, numbers, hyphens, and underscores"),
  coinAmount: z.number().int().min(1),
  maxClaims: z.number().int().min(1),
  validDays: z.number().int().min(1).max(3650),
});

export const updatePromoCodeSchema = z.object({
  isActive: z.boolean().optional(),
});

// Changing your own password. The current password is required so a
// stolen but still-valid token can't be used to lock the real owner out.
export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Enter your current password"),
    newPassword: z.string().min(6, "New password must be at least 6 characters"),
  })
  .refine((data) => data.currentPassword !== data.newPassword, {
    message: "New password must be different from your current one",
    path: ["newPassword"],
  });

// Editing your own profile. Email and phone are deliberately absent:
// they're identity anchors used for login and support, so they can only
// be changed by an admin, not self-served.
export const updateProfileSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters").max(50),
  username: z
    .string()
    .min(3, "Username must be at least 3 characters")
    .max(20)
    .regex(/^[a-zA-Z0-9_.]+$/, "Username can only use letters, numbers, dot and underscore"),
  // Required once a user edits their profile, but stored as a plain date
  // string so a timezone shift can't move someone's birthday by a day.
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date of birth must be in YYYY-MM-DD format"),
  nidNumber: z.string().max(30).optional().or(z.literal("")),
  // Set by the app's uploader, which returns a hosted imgbb URL — users
  // no longer type this by hand.
  avatarUrl: z.string().url("Invalid image URL").optional().or(z.literal("")),
});

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
