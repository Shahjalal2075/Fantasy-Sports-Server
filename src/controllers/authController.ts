import { Request, Response } from "express";
import bcrypt from "bcryptjs";
import prisma from "../config/prisma";
import { signToken } from "../utils/jwt";
import {
  registerSchema,
  loginSchema,
  changePasswordSchema,
  updateProfileSchema,
} from "../utils/validators";
import {
  generateUniqueReferralCode,
  resolveReferral,
  getReferralSummary,
} from "../services/referralService";

/**
 * bcrypt cost factor.
 *
 * Lowered from 10 to 8 for a specific reason: this project uses bcryptjs
 * (pure JavaScript, no native binary), and it runs on a 0.1-CPU
 * instance. Each cost increment doubles the work, and because hashing is
 * synchronous CPU it blocks Node's event loop — meaning a burst of
 * logins doesn't just queue, it stalls *every* other request behind it.
 *
 * At cost 10 on that hardware a single hash could occupy the loop for
 * over a second. Cost 8 is 4x cheaper and still ~2^8 iterations of
 * salted bcrypt, which remains well beyond feasible offline cracking for
 * this threat model (there is no real money in these accounts).
 *
 * Raise this back to 10-12 when moving to a real CPU allocation, or
 * switch to the native `bcrypt` package, which is several times faster
 * than bcryptjs at the same cost.
 */
const SALT_ROUNDS = 8;

export async function register(req: Request, res: Response) {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const { name, username, email, phone, password, referralCode } = parsed.data;

  const [existingEmail, existingUsername] = await Promise.all([
    prisma.user.findUnique({ where: { email } }),
    prisma.user.findUnique({ where: { username } }),
  ]);
  if (existingEmail) {
    return res.status(409).json({ error: "An account with this email already exists" });
  }
  if (existingUsername) {
    return res.status(409).json({ error: "This username is already taken" });
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  const user = await prisma.user.create({
    data: {
      name,
      username,
      email,
      phone,
      passwordHash,
      referredByCode: referralCode || undefined,
      referralCode: await generateUniqueReferralCode(),
    },
  });

  // Credits the new user immediately and links them to their inviter.
  // An unknown code is ignored rather than failing signup — the inviter
  // is paid later, once this user joins their first paid contest.
  const { referrerId } = await resolveReferral(referralCode, user.id);
  if (referrerId) {
    await prisma.user.update({ where: { id: user.id }, data: { referredById: referrerId } });
  }

  const token = signToken({ userId: user.id, email: user.email });

  return res.status(201).json({
    token,
    user: {
      id: user.id,
      name: user.name,
      username: user.username,
      email: user.email,
      totalPoints: user.totalPoints,
      coins: user.coins,
      isAdmin: user.isAdmin,
    },
  });
}

export async function login(req: Request, res: Response) {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const { email, password } = parsed.data;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    return res.status(401).json({ error: "Invalid email or password" });
  }

  const isValidPassword = await bcrypt.compare(password, user.passwordHash);
  if (!isValidPassword) {
    return res.status(401).json({ error: "Invalid email or password" });
  }

  if (user.isBanned) {
    return res.status(403).json({ error: user.bannedReason || "This account has been banned" });
  }

  const token = signToken({ userId: user.id, email: user.email });

  return res.status(200).json({
    token,
    user: {
      id: user.id,
      name: user.name,
      username: user.username,
      email: user.email,
      totalPoints: user.totalPoints,
      coins: user.coins,
      isAdmin: user.isAdmin,
    },
  });
}

export async function getProfile(req: Request, res: Response) {
  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    select: {
      id: true,
      name: true,
      username: true,
      email: true,
      phone: true,
      avatarUrl: true,
      referralCode: true,
      isVerified: true,
      dateOfBirth: true,
      nidNumber: true,
      usernameChangedAt: true,
      avatarChangedAt: true,
      totalPoints: true,
      coins: true,
      isAdmin: true,
      createdAt: true,
    },
  });

  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }

  // Ship the cooldown state alongside the profile so the Edit Profile
  // screen can disable a field and say when it unlocks, instead of
  // letting the user type a new username only to be rejected on save.
  return res.status(200).json({
    user,
    limits: {
      username: describeCooldown(user.usernameChangedAt, USERNAME_COOLDOWN_DAYS),
      avatar: describeCooldown(user.avatarChangedAt, AVATAR_COOLDOWN_DAYS),
    },
  });
}

// PATCH /api/auth/password  (auth required)
export async function changePassword(req: Request, res: Response) {
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const userId = req.userId as string;
  const { currentPassword, newPassword } = parsed.data;

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }

  const isValidPassword = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!isValidPassword) {
    return res.status(400).json({ error: "Your current password is incorrect" });
  }

  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: await bcrypt.hash(newPassword, SALT_ROUNDS) },
  });

  // Existing tokens stay valid on purpose — the user changed this from
  // inside their own session, so signing them out here would only be an
  // inconvenience.
  return res.status(200).json({ message: "Password updated" });
}

// ---------- Profile editing ----------

// A username may change once every two months, an avatar once a week.
// The limits exist so a user can't churn their identity between contests
// and make themselves hard to recognise on a leaderboard.
const USERNAME_COOLDOWN_DAYS = 60;
const AVATAR_COOLDOWN_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

function describeCooldown(lastChangedAt: Date | null, cooldownDays: number) {
  if (!lastChangedAt) {
    return { canChange: true, nextChangeAt: null, cooldownDays };
  }
  const nextChangeAt = new Date(lastChangedAt.getTime() + cooldownDays * DAY_MS);
  return {
    canChange: Date.now() >= nextChangeAt.getTime(),
    nextChangeAt,
    cooldownDays,
  };
}

// PATCH /api/auth/profile  (auth required)
export async function updateProfile(req: Request, res: Response) {
  const parsed = updateProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const userId = req.userId as string;
  const { name, username, dateOfBirth, nidNumber, avatarUrl } = parsed.data;

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }

  const now = new Date();
  const data: Record<string, unknown> = {
    name,
    // Parsed as midnight UTC so the stored date matches what was typed.
    dateOfBirth: new Date(`${dateOfBirth}T00:00:00.000Z`),
    nidNumber: nidNumber ? nidNumber : null,
  };

  // ---- username ----
  const usernameChanged = username !== user.username;
  if (usernameChanged) {
    const limit = describeCooldown(user.usernameChangedAt, USERNAME_COOLDOWN_DAYS);
    if (!limit.canChange) {
      return res.status(400).json({
        error: `You can change your username once every ${USERNAME_COOLDOWN_DAYS} days. Next change available on ${limit.nextChangeAt?.toDateString()}.`,
      });
    }

    // Check before writing so the user gets a clear message rather than
    // a raw unique-constraint error.
    const taken = await prisma.user.findUnique({ where: { username } });
    if (taken && taken.id !== userId) {
      return res.status(409).json({ error: "That username is already taken" });
    }

    data.username = username;
    data.usernameChangedAt = now;
  }

  // ---- avatar ----
  const nextAvatar = avatarUrl ? avatarUrl : null;
  const avatarChanged = nextAvatar !== (user.avatarUrl ?? null);
  if (avatarChanged) {
    const limit = describeCooldown(user.avatarChangedAt, AVATAR_COOLDOWN_DAYS);
    if (!limit.canChange) {
      return res.status(400).json({
        error: `You can change your profile picture once every ${AVATAR_COOLDOWN_DAYS} days. Next change available on ${limit.nextChangeAt?.toDateString()}.`,
      });
    }
    data.avatarUrl = nextAvatar;
    data.avatarChangedAt = now;
  }

  try {
    const updated = await prisma.user.update({
      where: { id: userId },
      data,
      select: {
        id: true,
        name: true,
        username: true,
        email: true,
        phone: true,
        avatarUrl: true,
        referralCode: true,
        isVerified: true,
        dateOfBirth: true,
        nidNumber: true,
        usernameChangedAt: true,
        avatarChangedAt: true,
        totalPoints: true,
        coins: true,
        isAdmin: true,
        createdAt: true,
      },
    });

    return res.status(200).json({
      user: updated,
      limits: {
        username: describeCooldown(updated.usernameChangedAt, USERNAME_COOLDOWN_DAYS),
        avatar: describeCooldown(updated.avatarChangedAt, AVATAR_COOLDOWN_DAYS),
      },
    });
  } catch (err: any) {
    // Covers the race where someone else claimed the username between
    // the check above and this write.
    if (err.code === "P2002") {
      return res.status(409).json({ error: "That username is already taken" });
    }
    throw err;
  }
}

// GET /api/auth/referrals  (auth required)
// Everything the Refer a Friend screen needs: the user's own code, how
// many people used it, and how much it has earned them.
export async function getReferrals(req: Request, res: Response) {
  const summary = await getReferralSummary(req.userId as string);
  return res.status(200).json({ referral: summary });
}
