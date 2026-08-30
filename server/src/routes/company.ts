import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { and, eq, isNull, ne } from "drizzle-orm";
import { db } from "../db/client.js";
import { companies, companyInvites, defaultFeatureFlags, users, type CompanyFeatureFlags } from "../db/schema.js";
import { generateToken, hashToken } from "../lib/tokens.js";
import { sendMail } from "../lib/mailer.js";
import { handleLogoUpload } from "../lib/uploads.js";
import { requirePermission } from "../lib/permissions.js";
import { recordAuditEvent } from "../lib/audit.js";
import { logger } from "../lib/logger.js";
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
    columns: { id: true, name: true, email: true, role: true, status: true, createdAt: true },
  });
  res.json(rows);
});

// MIDAD Phase A — role change / deactivate / reactivate, folded into one
// route (mirrors the exact same PATCH-with-optional-status pattern
// suppliers.ts/customers.ts already use for their own active/inactive
// toggle). Owner-gated via the SAME company.manage permission every other
// member-management action in this file already requires — no new
// permission, matching "preserve existing owner/member semantics unless
// discovery proves a change is required."
const updateMemberSchema = z.object({
  role: z.enum(["owner", "member"]).optional(),
  status: z.enum(["active", "deactivated"]).optional(),
});

companyRouter.patch("/members/:id", requireOwner, async (req: Request<{ id: string }>, res: Response) => {
  const existing = await db.query.users.findFirst({
    where: and(eq(users.id, req.params.id), eq(users.companyId, req.companyId!)),
  });
  if (!existing) return res.status(404).json({ error: "العضو غير موجود" });

  const parsed = updateMemberSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  if (Object.keys(parsed.data).length === 0) return res.json(existing);

  // Safety invariant, not a product decision: a company with zero active
  // owners can never again manage itself (no one left who can invite, set
  // roles, or reactivate anyone) — an unrecoverable state through this API.
  // Only checked when this specific change would actually remove an active
  // owner (demoting one, or deactivating one) — never blocks any other
  // change, including a member deactivating/promoting themselves when
  // other owners exist.
  const removesActiveOwner =
    existing.role === "owner" &&
    existing.status === "active" &&
    ((parsed.data.role !== undefined && parsed.data.role !== "owner") ||
      (parsed.data.status !== undefined && parsed.data.status !== "active"));

  if (removesActiveOwner) {
    const otherActiveOwners = await db.query.users.findMany({
      where: and(
        eq(users.companyId, req.companyId!),
        eq(users.role, "owner"),
        eq(users.status, "active"),
        ne(users.id, existing.id),
      ),
      columns: { id: true },
    });
    if (otherActiveOwners.length === 0) {
      return res.status(409).json({ error: "لا يمكن أن تبقى الشركة بدون مالك واحد نشط على الأقل" });
    }
  }

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx.update(users).set(parsed.data).where(eq(users.id, existing.id)).returning();

    if (parsed.data.role !== undefined && parsed.data.role !== existing.role) {
      await recordAuditEvent(tx, {
        companyId: req.companyId!,
        actorUserId: req.userId!,
        action: "user.roleChanged",
        entityType: "user",
        entityId: existing.id,
        beforeValue: { role: existing.role },
        afterValue: { role: row.role },
      });
    }
    if (parsed.data.status !== undefined && parsed.data.status !== existing.status) {
      await recordAuditEvent(tx, {
        companyId: req.companyId!,
        actorUserId: req.userId!,
        action: "user.statusChanged",
        entityType: "user",
        entityId: existing.id,
        beforeValue: { status: existing.status },
        afterValue: { status: row.status },
      });
      if (row.status === "deactivated") {
        logger.warn("destructive_mutation", {
          action: "user.deactivate",
          actorUserId: req.userId,
          companyId: req.companyId,
          targetUserId: existing.id,
        });
      }
    }

    return row;
  });

  res.json({ id: updated.id, name: updated.name, email: updated.email, role: updated.role, status: updated.status, createdAt: updated.createdAt });
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
