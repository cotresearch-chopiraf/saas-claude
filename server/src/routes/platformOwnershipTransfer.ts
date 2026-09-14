import { Router } from "express";
import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { platformOperators, platformOperatorSessions } from "../db/schema.js";
import { requirePlatformCapability } from "../lib/platformPermissions.js";
import { logger } from "../lib/logger.js";

// Wave 1C fix: thrown when the conditional demote-UPDATE below affects zero
// rows — meaning a concurrent transfer already demoted the previous owner
// first. Distinct from a plain Error so the route can map it to 409
// (a real, already-resolved conflict) rather than a 500.
class OwnershipTransferConflictError extends Error {}

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

  // Wave 1C fix — Ownership Transfer race: the checks above (including
  // "previousOwner.role !== platform_owner") are all plain reads taken
  // BEFORE this transaction opens. Without a condition on the demote
  // UPDATE itself, two concurrent transfer requests from the same owner
  // to two different targets could both pass every check above (neither
  // has committed yet) and then both unconditionally promote their own
  // target — leaving two accounts holding platform_owner at once, which
  // is exactly the invariant ("at most one platform_owner after any
  // transfer") this fix restores.
  //
  // The demote UPDATE below is now conditional on the row STILL holding
  // role='platform_owner' at the moment it actually runs — the same
  // atomic conditional-UPDATE discipline already used elsewhere in this
  // codebase (changeOrders.ts, boq.ts's publish route, compliance/
  // overrides.ts's resetOverride). Two concurrent transactions both
  // updating previousOwner's row serialize on that row's lock; whichever
  // commits first flips its role away from platform_owner, so the second
  // transaction's conditional UPDATE (re-evaluated against the now-
  // committed row once the lock is released) affects zero rows. That
  // failure is detected here and the whole transaction — including its
  // own newOwner promotion — is rolled back, so the losing request never
  // partially applies.
  let revokedSessionCount: number;
  try {
    revokedSessionCount = await db.transaction(async (tx) => {
      await tx.update(platformOperators).set({ role: "platform_owner", updatedAt: transferredAt }).where(eq(platformOperators.id, newOwner.id));
      // Demoted to platform_admin, never deactivated — prevents "orphaned
      // platform ownership" in the fuller sense: if anything goes wrong
      // with the new owner immediately after transfer, a highly-privileged
      // fallback operator still exists and can act, rather than the
      // platform being left with exactly one account holding any real
      // administrative capability.
      const [demoted] = await tx
        .update(platformOperators)
        .set({ role: "platform_admin", updatedAt: transferredAt })
        .where(and(eq(platformOperators.id, previousOwner.id), eq(platformOperators.role, "platform_owner")))
        .returning({ id: platformOperators.id });
      if (!demoted) throw new OwnershipTransferConflictError();

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
  } catch (err) {
    if (err instanceof OwnershipTransferConflictError) {
      return res.status(409).json({ error: "تم نقل الملكية بالفعل عبر طلب آخر — أعد تحميل الصفحة والمحاولة مجدداً" });
    }
    throw err;
  }

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
