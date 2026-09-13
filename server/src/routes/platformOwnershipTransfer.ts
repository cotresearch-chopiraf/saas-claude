import { Router } from "express";
import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { platformOperators, platformOperatorSessions } from "../db/schema.js";
import { requirePlatformCapability } from "../lib/platformPermissions.js";
import { logger } from "../lib/logger.js";

// MIDAD Final Pre-Launch audit, Phase 9 — Ownership Transfer. Gated by the
// "ownershipTransfer.manage" capability, which only platform_owner holds
// (see lib/platformPermissions.ts) — structurally prevents transfer by
// Support, Compliance, Auditor, or even Admin, satisfying "Current
// Platform Owner -> Select New Owner" and the "unauthorized transfer"/
// "transfer by Support"/"transfer by Auditor" prevention requirements
// without any extra check in this file.
//
// No new audit_events row: that table's companyId column is NOT NULL by
// design (every row belongs to exactly one tenant) and ownership transfer
// has no tenant at all — the same structural reason Phase 2's global
// feature-flag mutations already use logger.info() instead (see routes/
// platformFeatureFlags.ts's own header comment). This event uses the same
// precedent, logged with full before/after detail. The route's own JSON
// response IS the required "Transfer Report" — a structured summary of
// exactly what changed, returned synchronously rather than a separately
// persisted document, since the transaction that performs the transfer is
// the one authoritative source for what happened.
export const platformOwnershipTransferRouter = Router();

// MIDAD Final Pre-Launch audit, Phase 22 (UX) — the transfer UI needs a
// real list of candidate operators to pick a new owner from (typing a raw
// UUID is exactly the kind of error-prone flow this Phase's own
// confirmationEmail field already guards against). Same capability as the
// transfer itself: only platform_owner can even see who could become the
// next one. Never returns passwordHash.
platformOwnershipTransferRouter.get("/operators", requirePlatformCapability("ownershipTransfer.manage"), async (_req, res) => {
  const operators = await db.query.platformOperators.findMany({
    where: eq(platformOperators.status, "active"),
    columns: { id: true, name: true, email: true, role: true },
    orderBy: (o, { asc }) => [asc(o.name)],
  });
  res.json({ operators });
});

const transferSchema = z.object({
  newOwnerOperatorId: z.string().uuid("رقم العامل غير صالح"),
  // "Security Confirmation" / "Review Scope" — the caller must type the
  // exact email of the operator they are about to make Owner, not just
  // click a button next to a UUID. Deliberately not an OTP/2FA step: no
  // such infrastructure exists anywhere else in this codebase (platform
  // operators, like tenant users, authenticate with email+password only),
  // and inventing one here would be a new, undecided security mechanism
  // rather than an extension of what already exists.
  confirmationEmail: z.string().email("صيغة البريد الإلكتروني غير صحيحة"),
  reason: z.string().trim().min(3, "سبب نقل الملكية مطلوب"),
});

platformOwnershipTransferRouter.post("/", requirePlatformCapability("ownershipTransfer.manage"), async (req, res) => {
  const parsed = transferSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const { newOwnerOperatorId, confirmationEmail, reason } = parsed.data;

  // Prevents "self-confusing transfers" — transferring ownership to
  // yourself is not a real transfer and would only create confusion about
  // whether it happened.
  if (newOwnerOperatorId === req.platformOperatorId) {
    return res.status(400).json({ error: "لا يمكن نقل الملكية إلى نفس الحساب الحالي" });
  }

  const [previousOwner, newOwner] = await Promise.all([
    db.query.platformOperators.findFirst({ where: eq(platformOperators.id, req.platformOperatorId!) }),
    db.query.platformOperators.findFirst({ where: eq(platformOperators.id, newOwnerOperatorId) }),
  ]);

  if (!newOwner) return res.status(404).json({ error: "العامل المحدد كمالك جديد غير موجود" });
  if (newOwner.status !== "active") {
    return res.status(409).json({ error: "لا يمكن نقل الملكية إلى حساب غير مُفعّل" });
  }
  // Case-insensitive: the caller is confirming an identity, not typing a
  // password — matching case exactly would only cause spurious failures.
  if (confirmationEmail.toLowerCase() !== newOwner.email.toLowerCase()) {
    return res.status(400).json({ error: "البريد الإلكتروني للتأكيد لا يطابق بريد المالك الجديد" });
  }
  // Structurally shouldn't happen (the capability gate already requires
  // the caller to be platform_owner), but re-verified from the freshly
  // loaded row rather than trusted from the request — the same
  // defense-in-depth discipline every other mutation route in this
  // codebase already applies to its own preconditions.
  if (!previousOwner || previousOwner.role !== "platform_owner") {
    return res.status(409).json({ error: "الحساب الحالي ليس مالك المنصة" });
  }

  const transferredAt = new Date();

  const revokedSessionCount = await db.transaction(async (tx) => {
    await tx.update(platformOperators).set({ role: "platform_owner", updatedAt: transferredAt }).where(eq(platformOperators.id, newOwner.id));
    // Demoted to platform_admin, never deactivated — prevents "orphaned
    // platform ownership" in the fuller sense: if anything goes wrong
    // with the new owner immediately after transfer, a highly-privileged
    // fallback operator still exists and can act, rather than the
    // platform being left with exactly one account holding any real
    // administrative capability.
    await tx.update(platformOperators).set({ role: "platform_admin", updatedAt: transferredAt }).where(eq(platformOperators.id, previousOwner.id));

    // "Revoke Previous Owner Sessions" — every currently active session
    // belonging to the outgoing owner, including the one making this very
    // request (already past middleware/platformAuth.ts's check for this
    // request; the NEXT request with this token will correctly fail and
    // require a fresh login, which will mint a token reflecting the new
    // platform_admin role).
    const revoked = await tx
      .update(platformOperatorSessions)
      .set({ revokedAt: transferredAt })
      .where(and(eq(platformOperatorSessions.platformOperatorId, previousOwner.id), isNull(platformOperatorSessions.revokedAt)))
      .returning({ id: platformOperatorSessions.id });

    return revoked.length;
  });

  logger.info("platform_ownership_transferred", {
    previousOwnerId: previousOwner.id,
    previousOwnerEmail: previousOwner.email,
    newOwnerId: newOwner.id,
    newOwnerEmail: newOwner.email,
    reason,
    revokedSessionCount,
    transferredAt,
    requestId: req.requestId,
  });

  res.json({
    previousOwner: { id: previousOwner.id, email: previousOwner.email, newRole: "platform_admin" },
    newOwner: { id: newOwner.id, email: newOwner.email, newRole: "platform_owner" },
    reason,
    revokedSessionCount,
    transferredAt,
  });
});
