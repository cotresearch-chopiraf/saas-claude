import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { companies, companyInvites, defaultFeatureFlags, users, type CompanyFeatureFlags } from "../db/schema.js";
import { generateToken, hashToken } from "../lib/tokens.js";
import { sendMail } from "../lib/mailer.js";
import { handleLogoUpload } from "../lib/uploads.js";
import { requirePermission } from "../lib/permissions.js";
import { uploadFile, publicUrlFor } from "../lib/storage/index.js";

export const companyRouter = Router();

// Only the company owner can invite teammates or see pending invites.
// Backed by the shared permission matrix (lib/permissions.ts) rather than a
// standalone check, so this stays in sync with every other owner-only gate.
const requireOwner = requirePermission("company.manage");

companyRouter.get("/settings", async (req, res) => {
  const company = await db.query.companies.findFirst({ where: eq(companies.id, req.companyId!) });
  if (!company) return res.status(404).json({ error: "الشركة غير موجودة" });
  res.json({
    name: company.name,
    logoPath: company.logoPath,
    address: company.address,
    taxId: company.taxId,
    phone: company.phone,
    defaultTaxRatePercent: company.defaultTaxRatePercent,
    featureFlags: { ...defaultFeatureFlags, ...(company.featureFlags as CompanyFeatureFlags) },
  });
});

const settingsSchema = z.object({
  name: z.string().min(2).optional(),
  address: z.string().optional(),
  taxId: z.string().optional(),
  phone: z.string().optional(),
  defaultTaxRatePercent: z.coerce.number().min(0).max(100).optional(),
  featureFlags: z.object({ invoicing: z.boolean() }).partial().optional(),
});

// Every toggle here is opt-in/opt-out per company — this is the mechanism
// behind "أي ميزة نضيفها يبقى الاختيار للزبون": flip it in settings, not code.
companyRouter.patch("/settings", requireOwner, async (req, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const { featureFlags, defaultTaxRatePercent, ...rest } = parsed.data;
  const current = await db.query.companies.findFirst({ where: eq(companies.id, req.companyId!) });
  const mergedFlags = { ...defaultFeatureFlags, ...(current?.featureFlags as CompanyFeatureFlags), ...featureFlags };

  const [updated] = await db
    .update(companies)
    .set({
      ...rest,
      ...(defaultTaxRatePercent !== undefined ? { defaultTaxRatePercent: String(defaultTaxRatePercent) } : {}),
      featureFlags: mergedFlags,
    })
    .where(eq(companies.id, req.companyId!))
    .returning();

  res.json({
    name: updated.name,
    logoPath: updated.logoPath,
    address: updated.address,
    taxId: updated.taxId,
    phone: updated.phone,
    defaultTaxRatePercent: updated.defaultTaxRatePercent,
    featureFlags: updated.featureFlags,
  });
});

companyRouter.post("/logo", requireOwner, handleLogoUpload, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "لم يتم إرفاق ملف" });

  // Goes through the storage abstraction (lib/storage/) rather than
  // writing to disk directly — records a `files` metadata row (who/when/
  // checksum/size) for the same evidence-auditability reason every future
  // attachment will need, proven here on an already-existing feature.
  const file = await uploadFile({
    companyId: req.companyId!,
    uploadedBy: req.userId!,
    entityType: "company_logo",
    entityId: req.companyId!,
    buffer: req.file.buffer,
    fileName: req.file.originalname,
    mimeType: req.file.mimetype,
    namespace: "logos",
  });

  const logoPath = publicUrlFor(file.storageKey);
  await db.update(companies).set({ logoPath }).where(eq(companies.id, req.companyId!));
  res.json({ logoPath });
});

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
