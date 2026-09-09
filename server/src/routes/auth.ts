import { Router } from "express";
import { z } from "zod";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { companies, companyInvites, passwordResetTokens, userSessions, users } from "../db/schema.js";
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from "../lib/password.js";
import { signToken } from "../lib/jwt.js";
import { requireAuth } from "../middleware/auth.js";
import { authRateLimit } from "../middleware/rateLimit.js";
import { generateToken, hashToken } from "../lib/tokens.js";
import { sendMail } from "../lib/mailer.js";
import { logger } from "../lib/logger.js";
import { pgErrorInfo } from "../lib/pgError.js";

export const authRouter = Router();
authRouter.use(authRateLimit);

// One userSessions row per issued token — see that table's own schema
// comment. Every place this router hands out a token (register, login,
// accept-invite) goes through this single helper so none of them can drift
// out of sync with middleware/auth.ts's expectation that every sessionId
// it verifies has a backing row.
async function issueSessionToken(userId: string, companyId: string): Promise<string> {
  const [session] = await db.insert(userSessions).values({ userId }).returning({ id: userSessions.id });
  return signToken({ userId, companyId, sessionId: session.id });
}

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

  // The existing-email check above is only a fast-path (same TOCTOU shape
  // as accept-invite's own check-then-act race below): two near-
  // simultaneous registrations with the same email can both pass it.
  // Company and user creation are wrapped in one transaction so a losing
  // request's user insert (which fails on the users.email unique
  // constraint) rolls its company insert back too, instead of leaving an
  // orphaned, ownerless company row behind. The catch mirrors accept-
  // invite's own defense-in-depth 23505 handling for the identical
  // constraint, so a raw database error is never exposed to the client.
  const passwordHash = await hashPassword(password);
  let company: typeof companies.$inferSelect;
  let user: typeof users.$inferSelect;
  try {
    [company, user] = await db.transaction(async (tx) => {
      const [createdCompany] = await tx.insert(companies).values({ name: companyName }).returning();
      const [createdUser] = await tx
        .insert(users)
        .values({
          companyId: createdCompany.id,
          email,
          name,
          passwordHash,
          role: "owner",
        })
        .returning();
      return [createdCompany, createdUser] as const;
    });
  } catch (err) {
    if (pgErrorInfo(err).code === "23505") {
      return res.status(409).json({ error: "هذا البريد الإلكتروني مسجّل مسبقاً" });
    }
    throw err;
  }

  const token = await issueSessionToken(user.id, company.id);
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
  // AUTH-002: always run bcrypt.compare(), even when no account matches —
  // comparing against a fixed dummy hash instead of short-circuiting keeps
  // this branch's cost the same as the real-user branch below, so response
  // timing can't be used to tell whether an email is registered.
  const passwordMatches = await verifyPassword(password, user ? user.passwordHash : DUMMY_PASSWORD_HASH);
  if (!user || !passwordMatches) {
    return res.status(401).json({ error: "البريد الإلكتروني أو كلمة المرور غير صحيحة" });
  }

  const token = await issueSessionToken(user.id, user.companyId);
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

// Revokes only the current token's own session row — every other device
// this user is logged in on keeps working, matching ordinary "log out of
// this device" behavior. Idempotent: calling it twice, or with a token
// whose session is already revoked, is a no-op both times (requireAuth
// already refused the second call before this handler runs).
authRouter.post("/logout", requireAuth, async (req, res) => {
  await db.update(userSessions).set({ revokedAt: new Date() }).where(eq(userSessions.id, req.sessionId!));
  res.json({ message: "تم تسجيل الخروج" });
});

const requestResetSchema = z.object({ email: z.string().email() });

// AUTH-002: a nonexistent account does none of the work below (token
// insert, mail send) and would otherwise respond measurably faster than a
// real one — padding every response up to this floor absorbs that gap
// without creating a token or sending mail for an account that doesn't
// exist. It only ever adds wait time (max ~one floor's worth), never
// removes the real work's own latency.
const MIN_RESET_RESPONSE_MS = 150;

// Always answers the same way whether or not the email exists — the
// difference in response would otherwise let an attacker enumerate accounts.
authRouter.post("/request-password-reset", async (req, res) => {
  const parsed = requestResetSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "بريد إلكتروني غير صالح" });

  const startedAt = Date.now();
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

  const elapsedMs = Date.now() - startedAt;
  if (elapsedMs < MIN_RESET_RESPONSE_MS) {
    await new Promise((resolve) => setTimeout(resolve, MIN_RESET_RESPONSE_MS - elapsedMs));
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
    // A password reset is exactly the moment an account may have just been
    // compromised (or the owner is deliberately locking out a stolen
    // device) — revoke every existing session so this new password is the
    // only thing that gets back in, not just future logins.
    await tx
      .update(userSessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(userSessions.userId, record.userId), isNull(userSessions.revokedAt)));
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

  const token = await issueSessionToken(user.id, user.companyId);
  res.status(201).json({ token, user: { id: user.id, name: user.name, email: user.email } });
});
