import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { and, eq, isNull, ne } from "drizzle-orm";
import { db } from "../db/client.js";
import { companies, companyInvites, defaultFeatureFlags, users, type CompanyFeatureFlags } from "../db/schema.js";
import { generateToken, hashToken } from "../lib/tokens.js";
import { sendMail } from "../lib/mailer.js";
import { buildAppUrl } from "../lib/appUrl.js";
import { handleLogoUpload } from "../lib/uploads.js";
import { requirePermission } from "../lib/permissions.js";
import { recordAuditEvent } from "../lib/audit.js";
import { logger } from "../lib/logger.js";
import { uploadFile, publicUrlFor } from "../lib/storage/index.js";
import { assertWithinLimit, countActiveUsers, LimitExceededError } from "../lib/entitlements.js";
import { expensiveOperationRateLimit } from "../middleware/rateLimit.js";

export const companyRouter = Router();

// Wave 1E fix: thrown when the FOR UPDATE-locked re-check inside the
// transaction below finds that this change would still leave zero active
// owners — meaning a concurrent request already removed the other one.
// Distinct from a plain Error so the route can map it to 409 rather than 500.
class LastOwnerConflictError extends Error {}

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

  // 18-phase internal remediation, Phase 9 — this owner-gated,
  // company-wide settings mutation (including defaultTaxRatePercent, which
  // feeds every future invoice's tax fallback) had no audit trail at all,
  // unlike zatca.ts's near-identical PATCH /config. Wrapped in a
  // transaction so the update and its audit row commit atomically, same
  // discipline as every other audited mutation in this codebase.
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(companies)
      .set({
        ...rest,
        ...(defaultTaxRatePercent !== undefined ? { defaultTaxRatePercent: String(defaultTaxRatePercent) } : {}),
        featureFlags: mergedFlags,
      })
      .where(eq(companies.id, req.companyId!))
      .returning();

    await recordAuditEvent(tx, {
      companyId: req.companyId!,
      actorUserId: req.userId!,
      action: "company.settingsUpdated",
      entityType: "company",
      entityId: req.companyId!,
      beforeValue: current
        ? {
            name: current.name,
            address: current.address,
            taxId: current.taxId,
            phone: current.phone,
            defaultTaxRatePercent: current.defaultTaxRatePercent,
            featureFlags: current.featureFlags,
          }
        : null,
      afterValue: {
        name: row.name,
        address: row.address,
        taxId: row.taxId,
        phone: row.phone,
        defaultTaxRatePercent: row.defaultTaxRatePercent,
        featureFlags: row.featureFlags,
      },
    });

    return row;
  });

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

// 18-phase internal remediation, Phase 3 — logo upload had no rate
// limiter (low severity: owner-gated, size-limited by multer already, but
// still an unbounded storage-write loop for a compromised owner session).
companyRouter.post("/logo", requireOwner, expensiveOperationRateLimit, handleLogoUpload, async (req, res) => {
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
  // 18-phase internal remediation, Phase 9 (follow-up) — lower-severity
  // than the settings fix above (a cosmetic asset, not a financial/access
  // setting), but still a company-settings mutation with no prior trail.
  // The logoPath UPDATE and its audit event are wrapped together so an
  // audit-insert failure can't leave the company pointed at a new logo
  // with no record of who changed it. (uploadFile() above — the actual
  // disk write + files-table row — is its own, separately-atomic unit,
  // same as every other caller of the storage abstraction; only the
  // company-row mutation this audit event describes is wrapped here.)
  await db.transaction(async (tx) => {
    await tx.update(companies).set({ logoPath }).where(eq(companies.id, req.companyId!));
    await recordAuditEvent(tx, {
      companyId: req.companyId!,
      actorUserId: req.userId!,
      action: "company.logoUpdated",
      entityType: "company",
      entityId: req.companyId!,
      afterValue: { logoPath },
    });
  });

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
    // Fast-path only — a plain read taken before the transaction opens, so
    // a concurrent request racing this one can still slip past it (see the
    // authoritative, lock-based re-check inside the transaction below,
    // which is what actually closes the race).
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

  let updated;
  try {
    updated = await db.transaction(async (tx) => {
      // Wave 1E fix: locks every currently active-owner row for this
      // company (not just `existing`'s own row) before re-checking the
      // invariant. Two concurrent requests demoting/deactivating two
      // DIFFERENT owners target two different `users` rows, so a lock on
      // `existing.id` alone would never make them wait on each other —
      // locking the whole active-owner set is what forces the second
      // transaction to block until the first commits, then see the
      // now-current (post-commit) owner count rather than the stale
      // pre-transaction read. Same FOR UPDATE-before-checking discipline
      // as projects.ts's delete route.
      if (removesActiveOwner) {
        const lockedOwners = await tx
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.companyId, req.companyId!), eq(users.role, "owner"), eq(users.status, "active")))
          .for("update");
        const stillHasOtherOwner = lockedOwners.some((o) => o.id !== existing.id);
        if (!stillHasOtherOwner) {
          throw new LastOwnerConflictError();
        }
      }

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
  } catch (err) {
    if (err instanceof LastOwnerConflictError) {
      return res.status(409).json({ error: "لا يمكن أن تبقى الشركة بدون مالك واحد نشط على الأقل" });
    }
    throw err;
  }

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

  // P0 hardening (MIDAD Final Pre-Launch audit, §5/§19) — a plan's
  // maxUsers limit, evaluated centrally via lib/entitlements.ts. A company
  // with no plan assigned (planId = null, today's default for every
  // company) is unlimited — this only takes effect once a platform
  // operator explicitly assigns a plan with a real cap.
  try {
    await assertWithinLimit(req.companyId!, "maxUsers", await countActiveUsers(req.companyId!));
  } catch (err) {
    if (err instanceof LimitExceededError) return res.status(403).json({ error: err.message });
    throw err;
  }

  const token = generateToken();
  // 18-phase internal remediation, Phase 9 (follow-up) — the insert and
  // its audit event are atomic; the mail send below deliberately stays
  // OUTSIDE this transaction (unchanged from before) — it's not a DB
  // operation, and Slice AA's own already-established policy is that a
  // mail failure never rolls back or invalidates an invite that has
  // already durably committed.
  const invite = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(companyInvites)
      .values({
        companyId: req.companyId!,
        email: parsed.data.email,
        role: parsed.data.role,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      })
      .returning({ id: companyInvites.id, email: companyInvites.email, role: companyInvites.role });

    // An invite grants a role (including "owner") to whoever accepts it,
    // but issuing one had no audit trail — only the later role-change
    // route (PATCH /members/:id above) was audited. Recorded at issue
    // time, not acceptance, since the role was decided here.
    await recordAuditEvent(tx, {
      companyId: req.companyId!,
      actorUserId: req.userId!,
      action: "company.memberInvited",
      entityType: "company_invite",
      entityId: row.id,
      afterValue: { email: row.email, role: row.role },
    });
    return row;
  });

  // Slice AA — the invite row already exists regardless of delivery
  // outcome (an owner can always see it in GET /invites and resend by
  // recreating it), so a mail failure is logged and reported back via
  // emailDelivered rather than failing the whole request — this never
  // claims the email was delivered when it wasn't (see this slice's own
  // production-configuration rule).
  let emailDelivered = true;
  try {
    await sendMail(
      parsed.data.email,
      "دعوة للانضمام إلى فريقك على نظام تشغيل المقاولين",
      `رابط قبول الدعوة (صالح 7 أيام): ${buildAppUrl(`/accept-invite?token=${encodeURIComponent(token)}`)}`,
    );
  } catch {
    emailDelivered = false;
    logger.error("invite_email_failed", { companyId: req.companyId, inviteId: invite.id });
  }

  res.status(201).json({ ...invite, emailDelivered });
});

companyRouter.delete("/invites/:id", requireOwner, async (req, res) => {
  const existing = await db.query.companyInvites.findFirst({
    where: and(eq(companyInvites.id, req.params.id), eq(companyInvites.companyId, req.companyId!)),
  });
  if (!existing) return res.status(404).json({ error: "الدعوة غير موجودة" });

  // 18-phase internal remediation, Phase 9 (follow-up) — same gap as
  // invite creation, same transaction-wrapped atomicity.
  await db.transaction(async (tx) => {
    await tx.delete(companyInvites).where(eq(companyInvites.id, req.params.id));
    await recordAuditEvent(tx, {
      companyId: req.companyId!,
      actorUserId: req.userId!,
      action: "company.inviteRevoked",
      entityType: "company_invite",
      entityId: existing.id,
      beforeValue: { email: existing.email, role: existing.role },
    });
  });

  res.status(204).end();
});
