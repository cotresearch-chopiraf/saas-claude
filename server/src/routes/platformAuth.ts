import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { platformOperators } from "../db/schema.js";
import { verifyPassword } from "../lib/password.js";
import { signPlatformToken } from "../lib/platformJwt.js";
import { authRateLimit } from "../middleware/rateLimit.js";

// MIDAD Phase D1 — the ONLY authentication entry point for a platform
// operator. Deliberately: no registration route here (see
// db/seedPlatformOperator.ts for how the first operator is created — an
// out-of-band script, not an HTTP surface), no route that could let a
// tenant user or company owner reach a platform token, and no shared
// login path with routes/auth.ts's tenant authRouter — a tenant's email/
// password can never authenticate here because credentials are checked
// against platform_operators, a table tenant registration never writes to.
export const platformAuthRouter = Router();
// Same shared rate limiter every tenant /api/auth/* route already uses —
// credential-guessing risk is identical in kind here.
platformAuthRouter.use(authRateLimit);

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

platformAuthRouter.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "الرجاء إدخال بريد إلكتروني وكلمة مرور صحيحين" });
  }
  const { email, password } = parsed.data;

  const operator = await db.query.platformOperators.findFirst({ where: eq(platformOperators.email, email) });
  if (!operator || !(await verifyPassword(password, operator.passwordHash))) {
    return res.status(401).json({ error: "البريد الإلكتروني أو كلمة المرور غير صحيحة" });
  }
  // Checked only after credentials are proven valid — matches how
  // middleware/auth.ts's requireAuth reveals "deactivated" specifically
  // rather than a generic session error once identity is already
  // established, without helping an attacker who doesn't yet know the
  // password enumerate which operator accounts exist.
  if (operator.status !== "active") {
    return res.status(401).json({ error: "تم إلغاء تفعيل هذا الحساب" });
  }

  const token = signPlatformToken({ platformOperatorId: operator.id });
  res.json({ token, operator: { id: operator.id, name: operator.name, email: operator.email } });
});
