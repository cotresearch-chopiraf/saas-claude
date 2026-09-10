import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { clientPortalSessions, clientPortalUsers } from "../db/schema.js";
import { DUMMY_PASSWORD_HASH, verifyPassword } from "../lib/password.js";
import { signClientPortalToken } from "../lib/clientPortalJwt.js";
import { clientPortalAuth } from "../middleware/clientPortalAuth.js";
import { authRateLimit } from "../middleware/rateLimit.js";
import { recordAuditEvent } from "../lib/audit.js";

// MIDAD Phase B1 — the ONLY authentication entry point for a Client Portal
// User. Deliberately: no registration route here (a Client Portal User is
// only ever created by an internal owner via routes/clientPortalUsers.ts —
// there is no self-signup), and no shared login path with routes/auth.ts's
// tenant authRouter or routes/platformAuth.ts's platform router — a
// tenant's or platform operator's email/password can never authenticate
// here because credentials are checked against clientPortalUsers, a table
// neither of those registration paths ever writes to.
export const clientPortalAuthRouter = Router();
// Same shared rate limiter every other /api/*/auth/login route in this
// codebase already uses — credential-guessing risk is identical in kind.
clientPortalAuthRouter.use(authRateLimit);

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

clientPortalAuthRouter.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "الرجاء إدخال بريد إلكتروني وكلمة مرور صحيحين" });
  }
  const { email, password } = parsed.data;

  const portalUser = await db.query.clientPortalUsers.findFirst({ where: eq(clientPortalUsers.email, email) });
  // AUTH-002 discipline (routes/auth.ts) — always run bcrypt.compare(),
  // even when no account matches, comparing against a fixed dummy hash
  // instead of short-circuiting, so response timing can't be used to tell
  // whether an email is registered as a Client Portal User.
  const passwordMatches = await verifyPassword(password, portalUser ? portalUser.passwordHash : DUMMY_PASSWORD_HASH);
  if (!portalUser || !passwordMatches) {
    if (portalUser) {
      await recordAuditEvent(db, {
        companyId: portalUser.companyId,
        actorUserId: null,
        action: "client_portal.login_failed",
        entityType: "client_portal_user",
        entityId: portalUser.id,
        metadata: { email },
      });
    }
    return res.status(401).json({ error: "البريد الإلكتروني أو كلمة المرور غير صحيحة" });
  }
  if (portalUser.status !== "active") {
    await recordAuditEvent(db, {
      companyId: portalUser.companyId,
      actorUserId: null,
      action: "client_portal.login_failed",
      entityType: "client_portal_user",
      entityId: portalUser.id,
      metadata: { email, reason: "disabled" },
    });
    return res.status(401).json({ error: "تم إلغاء تفعيل هذا الحساب" });
  }

  const [session] = await db.insert(clientPortalSessions).values({ clientPortalUserId: portalUser.id }).returning();
  const token = signClientPortalToken({ clientPortalUserId: portalUser.id, sessionId: session.id });

  await recordAuditEvent(db, {
    companyId: portalUser.companyId,
    actorUserId: null,
    action: "client_portal.login",
    entityType: "client_portal_user",
    entityId: portalUser.id,
    metadata: { clientPortalUserId: portalUser.id, email: portalUser.email },
  });

  res.json({
    token,
    user: { id: portalUser.id, name: portalUser.name, email: portalUser.email },
  });
});

clientPortalAuthRouter.post("/logout", clientPortalAuth, async (req, res) => {
  await db
    .update(clientPortalSessions)
    .set({ revokedAt: new Date() })
    .where(eq(clientPortalSessions.id, req.clientPortalSessionId!));

  const portalUser = await db.query.clientPortalUsers.findFirst({
    where: eq(clientPortalUsers.id, req.clientPortalUserId!),
    columns: { companyId: true },
  });
  await recordAuditEvent(db, {
    companyId: portalUser!.companyId,
    actorUserId: null,
    action: "client_portal.logout",
    entityType: "client_portal_user",
    entityId: req.clientPortalUserId!,
    metadata: { clientPortalUserId: req.clientPortalUserId },
  });

  res.json({ message: "تم تسجيل الخروج" });
});
