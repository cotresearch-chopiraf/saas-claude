import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { companyInvites, users } from "../db/schema.js";
import { generateToken, hashToken } from "../lib/tokens.js";
import { sendMail } from "../lib/mailer.js";

export const companyRouter = Router();

// Only the company owner can invite teammates or see pending invites.
async function requireOwner(req: Request, res: Response, next: NextFunction) {
  const user = await db.query.users.findFirst({ where: eq(users.id, req.userId!) });
  if (user?.role !== "owner") {
    return res.status(403).json({ error: "هذا الإجراء متاح لمالك الشركة فقط" });
  }
  next();
}

companyRouter.get("/members", async (req, res) => {
  const rows = await db.query.users.findMany({
    where: eq(users.companyId, req.companyId!),
    columns: { id: true, name: true, email: true, role: true, createdAt: true },
  });
  res.json(rows);
});

companyRouter.get("/invites", requireOwner, async (req, res) => {
  const rows = await db.query.companyInvites.findMany({
    where: and(eq(companyInvites.companyId, req.companyId!), isNull(companyInvites.acceptedAt)),
    columns: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
  });
  res.json(rows);
});

const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(["owner", "member"]).default("member"),
});

companyRouter.post("/invites", requireOwner, async (req, res) => {
  const parsed = inviteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const existingUser = await db.query.users.findFirst({ where: eq(users.email, parsed.data.email) });
  if (existingUser) return res.status(409).json({ error: "هذا البريد الإلكتروني مسجّل مسبقاً" });

  const token = generateToken();
  const [invite] = await db
    .insert(companyInvites)
    .values({
      companyId: req.companyId!,
      email: parsed.data.email,
      role: parsed.data.role,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    })
    .returning({ id: companyInvites.id, email: companyInvites.email, role: companyInvites.role });

  sendMail(
    parsed.data.email,
    "دعوة للانضمام إلى فريقك على نظام تشغيل المقاولين",
    `رابط قبول الدعوة (صالح 7 أيام): /accept-invite?token=${token}`,
  );

  res.status(201).json(invite);
});

companyRouter.delete("/invites/:id", requireOwner, async (req, res) => {
  const existing = await db.query.companyInvites.findFirst({
    where: and(eq(companyInvites.id, req.params.id), eq(companyInvites.companyId, req.companyId!)),
  });
  if (!existing) return res.status(404).json({ error: "الدعوة غير موجودة" });

  await db.delete(companyInvites).where(eq(companyInvites.id, req.params.id));
  res.status(204).end();
});
