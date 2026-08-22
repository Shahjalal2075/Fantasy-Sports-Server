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
 * Called during signup. Resolves the typed code to a real user and
 * returns their id so the accounts can be linked.
 *
 * Deliberately pays nothing here. Both halves of the referral reward now
 * depend on an admin verifying the new user against their NID and date
 * of birth — otherwise someone could farm coins by registering throwaway
 * accounts with their own code.
 */
export async function resolveReferral(
  typedCode: string | undefined,
  newUserId: string
): Promise<{ referrerId: string | null }> {
  if (!typedCode) return { referrerId: null };

  const referrer = await prisma.user.findUnique({
    where: { referralCode: typedCode.trim().toUpperCase() },
    select: { id: true, isBanned: true },
  });

  // An unknown code is not an error — signup still succeeds, the user
  // just doesn't get the bonus. Failing here would block registration
  // over a typo.
  if (!referrer || referrer.id === newUserId || referrer.isBanned) {
    return { referrerId: null };
  }

  return { referrerId: referrer.id };
}

/**
 * Pays the invitee's joining bonus. Called when an admin verifies the
 * account — that check against NID and date of birth is what makes the
 * bonus worth paying.
 *
 * Safe to call repeatedly: the flag is claimed conditionally, so
 * verifying, unverifying and re-verifying can't pay twice.
 */
export async function paySignupBonusIfDue(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { referredById: true, referralSignupBonusPaid: true, isVerified: true },
  });

  // No referral code used, already paid, or not actually verified.
  if (!user?.referredById || user.referralSignupBonusPaid || !user.isVerified) return;

  const { signupBonus } = await loadRewardSettings();
  if (signupBonus <= 0) return;

  await prisma.$transaction(async (tx) => {
    const claimed = await tx.user.updateMany({
      where: { id: userId, referralSignupBonusPaid: false },
      data: { referralSignupBonusPaid: true },
    });
    if (claimed.count === 0) return;

    await creditCoins(tx, userId, signupBonus, "REFERRAL_BONUS", {
      reason: "Joining bonus for signing up with a referral code",
    });

    await tx.notification.create({
      data: {
        userId,
        type: "COIN_BONUS",
        title: "Referral bonus",
        message: `Your account has been verified! You received ${signupBonus} coins for signing up with a referral code.`,
        coinAmount: signupBonus,
      },
    });
  });
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
    select: {
      referredById: true,
      referralRewardPaid: true,
      isVerified: true,
      name: true,
      username: true,
    },
  });

  // Unverified accounts never trigger the inviter's reward — that's the
  // whole point of tying rewards to an admin identity check.
  if (!user?.referredById || user.referralRewardPaid || !user.isVerified) return;

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
