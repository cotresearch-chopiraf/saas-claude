import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { clientPortalUsers, clientProjectAccess, customers, projects } from "../db/schema.js";
import { requirePermission } from "../lib/permissions.js";
import { recordAuditEvent } from "../lib/audit.js";
import { hashPassword } from "../lib/password.js";
import { pgErrorInfo } from "../lib/pgError.js";

// MIDAD Phase B1 — internal, company-side management of Client Portal
// Users and their project access grants. This is NOT the Client Portal
// itself (see routes/clientPortalAuth.ts / clientPortalProjects.ts for
// that) — it is the tenant-facing admin surface an owner uses to create a
// client identity and decide which of THIS company's projects it may see.
// Every mutation here requires clientPortal.manage (owner-only, see
// permissions.ts's own comment on why this is its own action). Reads stay
// company-scoped but member-open, same split every other master-data
// domain in this matrix already uses.
export const clientPortalUsersRouter = Router();

clientPortalUsersRouter.get("/", async (req: Request, res: Response) => {
  const rows = await db.query.clientPortalUsers.findMany({
    where: eq(clientPortalUsers.companyId, req.companyId!),
    orderBy: (u, { asc }) => [asc(u.name)],
    // passwordHash is NEVER selected out — deliberately excluded at the
    // query level, not just omitted from the response shape by hand,
    // so a future field addition to this route can't accidentally leak it.
    columns: {
      id: true,
      companyId: true,
      customerId: true,
      name: true,
      email: true,
      status: true,
      createdBy: true,
      createdAt: true,
    },
  });
  res.json(rows);
});

const createSchema = z.object({
  name: z.string().min(2, "الاسم قصير جداً"),
  email: z.string().email("بريد إلكتروني غير صالح"),
  password: z.string().min(8, "كلمة المرور يجب أن تكون 8 أحرف على الأقل"),
  customerId: z.string().uuid().optional(),
});

clientPortalUsersRouter.post("/", requirePermission("clientPortal.manage"), async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  // customerId, if supplied, must belong to this company — same
  // ownership-validation discipline budget.ts already applies to
  // budgetItemId (never trust a foreign-key id as-is just because it
  // parses as a UUID).
  if (parsed.data.customerId) {
    const owningCustomer = await db.query.customers.findFirst({
      where: and(eq(customers.id, parsed.data.customerId), eq(customers.companyId, req.companyId!)),
    });
    if (!owningCustomer) return res.status(404).json({ error: "العميل غير موجود" });
  }

  const passwordHash = await hashPassword(parsed.data.password);

  try {
    const created = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(clientPortalUsers)
        .values({
          companyId: req.companyId!,
          customerId: parsed.data.customerId,
          name: parsed.data.name,
          email: parsed.data.email,
          passwordHash,
          createdBy: req.userId!,
        })
        .returning();

      await recordAuditEvent(tx, {
        companyId: req.companyId!,
        actorUserId: req.userId!,
        action: "client_portal.user_created",
        entityType: "client_portal_user",
        entityId: row.id,
        afterValue: { id: row.id, name: row.name, email: row.email, customerId: row.customerId },
      });

      return row;
    });

    res.status(201).json({
      id: created.id,
      companyId: created.companyId,
      customerId: created.customerId,
      name: created.name,
      email: created.email,
      status: created.status,
      createdBy: created.createdBy,
      createdAt: created.createdAt,
    });
  } catch (err) {
    if (pgErrorInfo(err).code === "23505") {
      return res.status(409).json({ error: "هذا البريد الإلكتروني مسجّل مسبقاً" });
    }
    throw err;
  }
});

async function findOwnedPortalUser(companyId: string, id: string) {
  return db.query.clientPortalUsers.findFirst({
    where: and(eq(clientPortalUsers.id, id), eq(clientPortalUsers.companyId, companyId)),
  });
}

const updateStatusSchema = z.object({
  status: z.enum(["active", "deactivated"]),
});

clientPortalUsersRouter.patch(
  "/:id",
  requirePermission("clientPortal.manage"),
  async (req: Request<{ id: string }>, res: Response) => {
    const existing = await findOwnedPortalUser(req.companyId!, req.params.id);
    if (!existing) return res.status(404).json({ error: "المستخدم غير موجود" });

    const parsed = updateStatusSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

    if (parsed.data.status === existing.status) {
      const { passwordHash: _passwordHash, ...safe } = existing;
      return res.json(safe);
    }

    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(clientPortalUsers)
        .set({ status: parsed.data.status })
        .where(eq(clientPortalUsers.id, existing.id))
        .returning();

      await recordAuditEvent(tx, {
        companyId: req.companyId!,
        actorUserId: req.userId!,
        action: parsed.data.status === "active" ? "client_portal.user_enabled" : "client_portal.user_disabled",
        entityType: "client_portal_user",
        entityId: existing.id,
        beforeValue: { status: existing.status },
        afterValue: { status: row.status },
      });

      return row;
    });

    const { passwordHash: _passwordHash, ...safe } = updated;
    res.json(safe);
  },
);

const grantSchema = z.object({
  projectId: z.string().uuid(),
});

clientPortalUsersRouter.post(
  "/:id/access",
  requirePermission("clientPortal.manage"),
  async (req: Request<{ id: string }>, res: Response) => {
    const portalUser = await findOwnedPortalUser(req.companyId!, req.params.id);
    if (!portalUser) return res.status(404).json({ error: "المستخدم غير موجود" });

    const parsed = grantSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

    // The project must belong to THIS company — never trust the supplied
    // projectId as-is. This is the one point companyId is ever written
    // onto a client_project_access row; every future request re-derives
    // it from this row, never from client input again (see
    // requireClientProjectAccess.ts).
    const project = await db.query.projects.findFirst({
      where: and(eq(projects.id, parsed.data.projectId), eq(projects.companyId, req.companyId!)),
    });
    if (!project) return res.status(404).json({ error: "المشروع غير موجود" });

    try {
      const grant = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(clientProjectAccess)
          .values({
            companyId: req.companyId!,
            clientPortalUserId: portalUser.id,
            projectId: project.id,
            grantedBy: req.userId!,
          })
          .returning();

        await recordAuditEvent(tx, {
          companyId: req.companyId!,
          actorUserId: req.userId!,
          action: "client_portal.access_granted",
          entityType: "client_project_access",
          entityId: row.id,
          afterValue: row,
          metadata: { clientPortalUserId: portalUser.id, projectId: project.id },
        });

        return row;
      });

      res.status(201).json(grant);
    } catch (err) {
      if (pgErrorInfo(err).code === "23505") {
        return res.status(409).json({ error: "يملك هذا المستخدم صلاحية وصول فعّالة لهذا المشروع بالفعل" });
      }
      throw err;
    }
  },
);

clientPortalUsersRouter.post(
  "/:id/access/:projectId/revoke",
  requirePermission("clientPortal.manage"),
  async (req: Request<{ id: string; projectId: string }>, res: Response) => {
    const portalUser = await findOwnedPortalUser(req.companyId!, req.params.id);
    if (!portalUser) return res.status(404).json({ error: "المستخدم غير موجود" });

    const revoked = await db.transaction(async (tx) => {
      // Conditional UPDATE (WHERE revokedAt IS NULL) — same race-safe
      // "one winner" pattern invoices.ts's mark-paid and quotes.ts's
      // accept/reject already use, so two concurrent revoke attempts (or
      // a revoke racing this exact grant's own creation) can never both
      // report success or double-write revokedAt.
      const [row] = await tx
        .update(clientProjectAccess)
        .set({ revokedAt: new Date(), revokedBy: req.userId! })
        .where(
          and(
            eq(clientProjectAccess.clientPortalUserId, portalUser.id),
            eq(clientProjectAccess.projectId, req.params.projectId),
            eq(clientProjectAccess.companyId, req.companyId!),
            isNull(clientProjectAccess.revokedAt),
          ),
        )
        .returning();
      if (!row) return null;

      await recordAuditEvent(tx, {
        companyId: req.companyId!,
        actorUserId: req.userId!,
        action: "client_portal.access_revoked",
        entityType: "client_project_access",
        entityId: row.id,
        afterValue: row,
        metadata: { clientPortalUserId: portalUser.id, projectId: req.params.projectId },
      });

      return row;
    });

    if (!revoked) return res.status(409).json({ error: "لا توجد صلاحية وصول فعّالة لهذا المشروع لإلغائها" });
    res.json(revoked);
  },
);
