import bcrypt from "bcryptjs";
import nodemailer from "nodemailer";
import prisma from "../config/prisma";

/**
 * Email-based one-time codes for signup verification and password reset.
 *
 * Email rather than SMS because SMS to Bangladesh is never free — this
 * costs nothing on a provider's free tier. The send step is isolated in
 * sendEmail() so swapping in an SMS gateway later means writing one
 * function, not reworking the flow.
 */

const CODE_LENGTH = 6;
const CODE_TTL_MS = 5 * 60 * 1000;
// A code is burned after this many wrong guesses, so a 6-digit code
// can't be brute-forced (1M combinations, 5 tries).
const MAX_ATTEMPTS = 5;
// Stops someone using the send endpoint to spam an inbox — or to burn
// through a provider's daily quota.
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_PER_HOUR = 6;

const SMTP_HOST = process.env.SMTP_HOST ?? "";
const SMTP_PORT = Number(process.env.SMTP_PORT ?? 587);
const SMTP_USER = process.env.SMTP_USER ?? "";
const SMTP_PASS = process.env.SMTP_PASS ?? "";
const MAIL_FROM = process.env.MAIL_FROM ?? "Strong XI <no-reply@strongxi.app>";

let transporter: nodemailer.Transporter | null = null;

function getTransporter() {
  if (!SMTP_HOST || !SMTP_USER) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      // 465 is implicit TLS; 587 upgrades via STARTTLS.
      secure: SMTP_PORT === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
  }
  return transporter;
}

async function sendEmail(to: string, subject: string, html: string, text: string) {
  const mailer = getTransporter();

  if (!mailer) {
    // Without SMTP configured, log the code instead of failing. That
    // keeps local development usable, but it must never happen in
    // production — hence the loud warning.
    console.warn(
      `[otp] SMTP not configured. Would have emailed ${to}:\n${text}\n` +
        "Set SMTP_HOST / SMTP_USER / SMTP_PASS to send real messages."
    );
    return;
  }

  await mailer.sendMail({ from: MAIL_FROM, to, subject, html, text });
}

function randomCode(): string {
  // Zero-padded so codes are always six digits — "004321", not "4321".
  const max = 10 ** CODE_LENGTH;
  return String(Math.floor(Math.random() * max)).padStart(CODE_LENGTH, "0");
}

function otpEmailHtml(code: string, purpose: "EMAIL_VERIFICATION" | "PASSWORD_RESET") {
  const heading = purpose === "EMAIL_VERIFICATION" ? "Verify your email" : "Reset your password";
  const line =
    purpose === "EMAIL_VERIFICATION"
      ? "Use this code to finish creating your Strong XI account."
      : "Use this code to set a new password for your Strong XI account.";

  return `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;padding:24px">
    <h2 style="color:#E5473A;margin:0 0 8px">Strong XI</h2>
    <h3 style="margin:0 0 12px;color:#1B2430">${heading}</h3>
    <p style="color:#5A6273;line-height:1.6;margin:0 0 20px">${line}</p>
    <div style="background:#EAF0FB;border-radius:10px;padding:18px;text-align:center;margin-bottom:20px">
      <div style="font-size:32px;letter-spacing:8px;font-weight:700;color:#1B2430">${code}</div>
    </div>
    <p style="color:#8B93A3;font-size:13px;line-height:1.6;margin:0">
      This code expires in 5 minutes. If you didn't request it, you can ignore this email —
      nothing will change on your account.
    </p>
  </div>`;
}

export type OtpPurpose = "EMAIL_VERIFICATION" | "PASSWORD_RESET";

/**
 * Issues a code and emails it.
 *
 * Any earlier unconsumed code for the same email and purpose is expired
 * first, so only the newest code ever works — otherwise a user who hit
 * "resend" would have several valid codes floating around.
 */
export async function sendOtp(
  email: string,
  purpose: OtpPurpose
): Promise<{ ok: true } | { ok: false; error: string }> {
  const normalised = email.trim().toLowerCase();
  const now = new Date();

  const lastCode = await prisma.otpCode.findFirst({
    where: { email: normalised, purpose },
    orderBy: { createdAt: "desc" },
  });

  if (lastCode && now.getTime() - lastCode.createdAt.getTime() < RESEND_COOLDOWN_MS) {
    const secondsLeft = Math.ceil(
      (RESEND_COOLDOWN_MS - (now.getTime() - lastCode.createdAt.getTime())) / 1000
    );
    return { ok: false, error: `Please wait ${secondsLeft} seconds before requesting another code.` };
  }

  const recentCount = await prisma.otpCode.count({
    where: { email: normalised, purpose, createdAt: { gte: new Date(now.getTime() - 60 * 60 * 1000) } },
  });
  if (recentCount >= MAX_PER_HOUR) {
    return { ok: false, error: "Too many codes requested. Please try again in an hour." };
  }

  // Invalidate anything still outstanding.
  await prisma.otpCode.updateMany({
    where: { email: normalised, purpose, consumedAt: null },
    data: { expiresAt: now },
  });

  const code = randomCode();

  await prisma.otpCode.create({
    data: {
      email: normalised,
      // Hashed, so a database dump doesn't contain usable codes. Cost 8
      // to match the auth controller — these are short-lived anyway.
      codeHash: await bcrypt.hash(code, 8),
      purpose,
      expiresAt: new Date(now.getTime() + CODE_TTL_MS),
    },
  });

  await sendEmail(
    normalised,
    purpose === "EMAIL_VERIFICATION" ? "Your Strong XI verification code" : "Reset your Strong XI password",
    otpEmailHtml(code, purpose),
    `Your Strong XI code is ${code}. It expires in 5 minutes.`
  );

  return { ok: true };
}

/**
 * Checks a code and consumes it on success.
 *
 * Consuming means a code can't be replayed — important for password
 * reset, where the same code would otherwise let someone change the
 * password repeatedly.
 */
export async function verifyOtp(
  email: string,
  purpose: OtpPurpose,
  code: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const normalised = email.trim().toLowerCase();

  const record = await prisma.otpCode.findFirst({
    where: { email: normalised, purpose, consumedAt: null },
    orderBy: { createdAt: "desc" },
  });

  if (!record) {
    return { ok: false, error: "No active code for this email. Please request a new one." };
  }
  if (record.expiresAt <= new Date()) {
    return { ok: false, error: "That code has expired. Please request a new one." };
  }
  if (record.attempts >= MAX_ATTEMPTS) {
    return { ok: false, error: "Too many incorrect attempts. Please request a new code." };
  }

  const matches = await bcrypt.compare(code.trim(), record.codeHash);

  if (!matches) {
    await prisma.otpCode.update({
      where: { id: record.id },
      data: { attempts: { increment: 1 } },
    });
    const left = MAX_ATTEMPTS - (record.attempts + 1);
    return {
      ok: false,
      error:
        left > 0
          ? `Incorrect code. ${left} attempt${left === 1 ? "" : "s"} left.`
          : "Too many incorrect attempts. Please request a new code.",
    };
  }

  await prisma.otpCode.update({
    where: { id: record.id },
    data: { consumedAt: new Date() },
  });

  return { ok: true };
}
