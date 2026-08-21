import prisma from "../config/prisma";
import { creditCoins } from "./walletService";

// Ambiguous characters (0/O, 1/I/L) are left out: these codes get read
// off a screen and typed by hand, so confusable pairs cause failed
// signups and support tickets.
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_LENGTH = 8;

function randomCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

/**
 * A referral code that isn't already taken. 31^8 is a huge space, so a
 * collision is vanishingly unlikely — but the column is unique, and a
 * clash would fail the whole signup, so it's worth the retry loop.
 */
export async function generateUniqueReferralCode(): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const code = randomCode();
    const existing = await prisma.user.findUnique({ where: { referralCode: code } });
    if (!existing) return code;
  }
  // Fall back to something guaranteed unique rather than giving up.
  return `${randomCode()}${Date.now().toString(36).toUpperCase().slice(-4)}`;
}

async function loadRewardSettings() {
  const settings = await prisma.appSettings.upsert({
    where: { id: 1 },
    create: { id: 1 },
    update: {},
  });
  return {
    signupBonus: settings.referralSignupBonus,
    inviterBonus: settings.referralInviterBonus,
  };
}

/**
 * Called during signup. Resolves the typed code to a real user and pays
 * the NEW user their joining bonus straight away.
 *
 * Returns the inviter's id so the caller can link the accounts, or null
 * when the code was blank, unknown, or the user's own.
 */
export async function resolveReferral(
  typedCode: string | undefined,
  newUserId: string
): Promise<{ referrerId: string | null; bonusCredited: number }> {
  if (!typedCode) return { referrerId: null, bonusCredited: 0 };

  const referrer = await prisma.user.findUnique({
    where: { referralCode: typedCode.trim().toUpperCase() },
    select: { id: true, isBanned: true },
  });

  // An unknown code is not an error — signup still succeeds, the user
  // just doesn't get the bonus. Failing here would block registration
  // over a typo.
  if (!referrer || referrer.id === newUserId || referrer.isBanned) {
    return { referrerId: null, bonusCredited: 0 };
  }

  const { signupBonus } = await loadRewardSettings();
  if (signupBonus <= 0) return { referrerId: referrer.id, bonusCredited: 0 };

  await prisma.$transaction(async (tx) => {
    await creditCoins(tx, newUserId, signupBonus, "REFERRAL_BONUS", {
      reason: "Joining bonus for signing up with a referral code",
    });
    await tx.notification.create({
      data: {
        userId: newUserId,
        type: "COIN_BONUS",
        title: "Referral bonus",
        message: `You received ${signupBonus} coins for joining with a referral code. Welcome to Strong XI!`,
        coinAmount: signupBonus,
      },
    });
  });

  return { referrerId: referrer.id, bonusCredited: signupBonus };
}

/**
 * Called after a user successfully joins a PAID contest.
 *
 * Pays the inviter, but only the first time — `referralRewardPaid` is
 * flipped in the same transaction, and the update is guarded on it still
 * being false so two concurrent joins can't both pay out.
 */
export async function payInviterIfDue(userId: string, entryCost: number): Promise<void> {
  // Free contests don't count: otherwise a throwaway account could sign
  // up, join a free contest and mint coins for its creator.
  if (entryCost <= 0) return;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { referredById: true, referralRewardPaid: true, name: true, username: true },
  });

  if (!user?.referredById || user.referralRewardPaid) return;

  const { inviterBonus } = await loadRewardSettings();
  if (inviterBonus <= 0) return;

  await prisma.$transaction(async (tx) => {
    // Conditional update: if another request already flipped the flag,
    // this matches zero rows and we skip the payout entirely.
    const claimed = await tx.user.updateMany({
      where: { id: userId, referralRewardPaid: false },
      data: { referralRewardPaid: true },
    });
    if (claimed.count === 0) return;

    await creditCoins(tx, user.referredById as string, inviterBonus, "REFERRAL_BONUS", {
      reason: `Referral reward — ${user.username} joined their first paid contest`,
    });

    await tx.notification.create({
      data: {
        userId: user.referredById as string,
        type: "COIN_BONUS",
        title: "Referral reward",
        message: `${user.name} (@${user.username}) joined their first paid contest. You earned ${inviterBonus} coins!`,
        coinAmount: inviterBonus,
      },
    });
  });
}

/** Stats for the app's Refer a Friend screen. */
export async function getReferralSummary(userId: string) {
  const [user, settings] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { referralCode: true },
    }),
    loadRewardSettings(),
  ]);

  const [totalInvited, rewardedCount, earned] = await Promise.all([
    prisma.user.count({ where: { referredById: userId } }),
    // Invitees who have already triggered the inviter payout.
    prisma.user.count({ where: { referredById: userId, referralRewardPaid: true } }),
    prisma.coinTransaction.aggregate({
      where: { userId, type: "REFERRAL_BONUS" },
      _sum: { amount: true },
    }),
  ]);

  return {
    referralCode: user?.referralCode ?? "",
    totalInvited,
    rewardedCount,
    pendingCount: totalInvited - rewardedCount,
    coinsEarned: earned._sum.amount ?? 0,
    signupBonus: settings.signupBonus,
    inviterBonus: settings.inviterBonus,
  };
}
