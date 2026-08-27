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

authRouter.get("/me", requireAuth, async (req, res) => {
  const user = await db.query.users.findFirst({ where: eq(users.id, req.userId!) });
  if (!user) return res.status(404).json({ error: "المستخدم غير موجود" });

  const company = await db.query.companies.findFirst({ where: eq(companies.id, user.companyId) });
  res.json({
    user: { id: user.id, name: user.name, email: user.email },
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
    sendMail(
      user.email,
      "إعادة تعيين كلمة المرور",
      `رابط إعادة التعيين (صالح لساعة واحدة): /reset-password?token=${token}`,
    );
  }
  res.json({ message: "إن كان البريد الإلكتروني مسجّلاً، سيصلك رابط إعادة التعيين" });
});

const resetSchema = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(8, "كلمة المرور يجب أن تكون 8 أحرف على الأقل"),
});

authRouter.post("/reset-password", async (req, res) => {
  const parsed = resetSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const tokenHash = hashToken(parsed.data.token);
  const record = await db.query.passwordResetTokens.findFirst({
    where: and(
      eq(passwordResetTokens.tokenHash, tokenHash),
      isNull(passwordResetTokens.usedAt),
      gt(passwordResetTokens.expiresAt, new Date()),
    ),
  });
  if (!record) return res.status(400).json({ error: "رابط إعادة التعيين غير صالح أو منتهي الصلاحية" });

  await db
    .update(users)
    .set({ passwordHash: await hashPassword(parsed.data.newPassword) })
    .where(eq(users.id, record.userId));
  await db.update(passwordResetTokens).set({ usedAt: new Date() }).where(eq(passwordResetTokens.id, record.id));

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

  const [user] = await db
    .insert(users)
    .values({
      companyId: invite.companyId,
      email: invite.email,
      name: parsed.data.name,
      passwordHash: await hashPassword(parsed.data.password),
      role: invite.role,
    })
    .returning();
  await db.update(companyInvites).set({ acceptedAt: new Date() }).where(eq(companyInvites.id, invite.id));

  const token = signToken({ userId: user.id, companyId: user.companyId });
  res.status(201).json({ token, user: { id: user.id, name: user.name, email: user.email } });
});
