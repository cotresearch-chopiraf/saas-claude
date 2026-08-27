import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { companies, users } from "../db/schema.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import { signToken } from "../lib/jwt.js";
import { requireAuth } from "../middleware/auth.js";

export const authRouter = Router();

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
