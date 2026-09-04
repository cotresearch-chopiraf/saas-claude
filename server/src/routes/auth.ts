import { Router } from "express";
import { z } from "zod";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { companies, companyInvites, passwordResetTokens, users } from "../db/schema.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import { signToken } from "../lib/jwt.js";
import { requireAuth } from "../middleware/auth.js";
import { authRateLimit } from "../middleware/rateLimit.js";
import { generateToken, hashToken } from "../lib/tokens.js";
import { sendMail } from "../lib/mailer.js";
import { logger } from "../lib/logger.js";
import { pgErrorInfo } from "../lib/pgError.js";

export const authRouter = Router();
authRouter.use(authRateLimit);

const registerSchema = z.object({
  companyName: z.string().min(2, "اسم الشركة قصير جداً"),
  name: z.string().min(2, "الاسم قصير جداً"),
  email: z.string().email("بريد إلكتروني غير صالح"),
  password: z.string().min(8, "كلمة المرور يجب أن تكون 8 أحرف على الأقل"),
});

authRouter.post("/register", async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }
  const { companyName, name, email, password } = parsed.data;

  const existing = await db.query.users.findFirst({ where: eq(users.email, email) });
  if (existing) {
    return res.status(409).json({ error: "هذا البريد الإلكتروني مسجّل مسبقاً" });
  }

  const [company] = await db.insert(companies).values({ name: companyName }).returning();
  const [user] = await db
    .insert(users)
    .values({
      companyId: company.id,
      email,
      name,
      passwordHash: await hashPassword(password),
      role: "owner",
    })
    .returning();

  const token = signToken({ userId: user.id, companyId: company.id });
  res.status(201).json({
    token,
    user: { id: user.id, name: user.name, email: user.email },
    company: { id: company.id, name: company.name },
  });
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

authRouter.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "الرجاء إدخال بريد إلكتروني وكلمة مرور صحيحين" });
  }
  const { email, password } = parsed.data;

  const user = await db.query.users.findFirst({ where: eq(users.email, email) });
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    return res.status(401).json({ error: "البريد الإلكتروني أو كلمة المرور غير صحيحة" });
  }

  const token = signToken({ userId: user.id, companyId: user.companyId });
  res.json({
    token,
    user: { id: user.id, name: user.name, email: user.email },
  });
});

// role is included so the frontend can render owner-only actions without
// guessing — the backend remains the sole authorization authority (every
// mutation route still independently re-checks the role from the DB via
// requirePermission), this is presentation information only.
authRouter.get("/me", requireAuth, async (req, res) => {
  const user = await db.query.users.findFirst({ where: eq(users.id, req.userId!) });
  if (!user) return res.status(404).json({ error: "المستخدم غير موجود" });

  const company = await db.query.companies.findFirst({ where: eq(companies.id, user.companyId) });
  res.json({
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
    company: company ? { id: company.id, name: company.name } : null,
  });
});

const requestResetSchema = z.object({ email: z.string().email() });

// Always answers the same way whether or not the email exists — the
// difference in response would otherwise let an attacker enumerate accounts.
authRouter.post("/request-password-reset", async (req, res) => {
  const parsed = requestResetSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "بريد إلكتروني غير صالح" });

  const user = await db.query.users.findFirst({ where: eq(users.email, parsed.data.email) });
  if (user) {
    const token = generateToken();
    await db.insert(passwordResetTokens).values({
      userId: user.id,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    // Slice AA — this response's own security property (never reveal
    // whether the email exists) must hold regardless of delivery outcome,
    // so a mail-provider failure is logged, not surfaced to the caller —
    // changing the response here would itself be an account-enumeration
    // side channel (a real user always gets one response shape, a
    // production delivery failure must never produce a different one).
    try {
      await sendMail(
        user.email,
        "إعادة تعيين كلمة المرور",
        `رابط إعادة التعيين (صالح لساعة واحدة): /reset-password?token=${token}`,
      );
    } catch {
      logger.error("password_reset_email_failed", { userId: user.id });
    }
  }
  res.json({ message: "إن كان البريد الإلكتروني مسجّلاً، سيصلك رابط إعادة التعيين" });
});

const resetSchema = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(8, "كلمة المرور يجب أن تكون 8 أحرف على الأقل"),
});

// Consuming the token is a single conditional UPDATE (WHERE usedAt IS NULL),
// not an earlier SELECT followed by a separate UPDATE — that is what makes
// this atomic against two concurrent reset-password calls racing on the
// same token: only one of them can ever find the row still unused at the
// moment its own UPDATE executes, regardless of how close together the two
// requests arrive.
authRouter.post("/reset-password", async (req, res) => {
  const parsed = resetSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const tokenHash = hashToken(parsed.data.token);
  const newPasswordHash = await hashPassword(parsed.data.newPassword);

  const consumed = await db.transaction(async (tx) => {
    const [record] = await tx
      .update(passwordResetTokens)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(passwordResetTokens.tokenHash, tokenHash),
          isNull(passwordResetTokens.usedAt),
          gt(passwordResetTokens.expiresAt, new Date()),
        ),
      )
      .returning();
    if (!record) return null;

    await tx.update(users).set({ passwordHash: newPasswordHash }).where(eq(users.id, record.userId));
    return record;
  });

  if (!consumed) return res.status(400).json({ error: "رابط إعادة التعيين غير صالح أو منتهي الصلاحية" });

  res.json({ message: "تم تحديث كلمة المرور بنجاح" });
});

const acceptInviteSchema = z.object({
  token: z.string().min(1),
  name: z.string().min(2, "الاسم قصير جداً"),
  password: z.string().min(8, "كلمة المرور يجب أن تكون 8 أحرف على الأقل"),
});

authRouter.post("/accept-invite", async (req, res) => {
  const parsed = acceptInviteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const tokenHash = hashToken(parsed.data.token);
  const invite = await db.query.companyInvites.findFirst({
    where: and(
      eq(companyInvites.tokenHash, tokenHash),
      isNull(companyInvites.acceptedAt),
      gt(companyInvites.expiresAt, new Date()),
    ),
  });
  if (!invite) return res.status(400).json({ error: "الدعوة غير صالحة أو منتهية الصلاحية" });

  const existing = await db.query.users.findFirst({ where: eq(users.email, invite.email) });
  if (existing) return res.status(409).json({ error: "هذا البريد الإلكتروني مسجّل مسبقاً" });

  // Atomically claim the invite (same conditional-UPDATE pattern used
  // elsewhere for check-then-act races — invoice mark-paid, quote
  // accept/reject, ZATCA submission claim). Two concurrent accept-invite
  // requests for the same token both pass the SELECT above; only one can
  // win this UPDATE, closing the TOCTOU gap that previously let both reach
  // the insert below and crash the loser on the users.email unique
  // constraint instead of returning a clean conflict.
  const [claimedInvite] = await db
    .update(companyInvites)
    .set({ acceptedAt: new Date() })
    .where(
      and(
        eq(companyInvites.id, invite.id),
        isNull(companyInvites.acceptedAt),
        gt(companyInvites.expiresAt, new Date()),
      ),
    )
    .returning();
  if (!claimedInvite) {
    return res.status(409).json({ error: "تم استخدام هذه الدعوة بالفعل" });
  }

  let user;
  try {
    [user] = await db
      .insert(users)
      .values({
        companyId: invite.companyId,
        email: invite.email,
        name: parsed.data.name,
        passwordHash: await hashPassword(parsed.data.password),
        role: invite.role,
      })
      .returning();
  } catch (err) {
    // Defense in depth: a different invite racing for the same email
    // (outside this token's own claim gate above) would still hit the
    // users.email unique constraint — surface it as a conflict, not a 500.
    if (pgErrorInfo(err).code === "23505") {
      return res.status(409).json({ error: "هذا البريد الإلكتروني مسجّل مسبقاً" });
    }
    throw err;
  }

  const token = signToken({ userId: user.id, companyId: user.companyId });
  res.status(201).json({ token, user: { id: user.id, name: user.name, email: user.email } });
});
