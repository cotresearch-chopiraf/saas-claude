import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { customers, projects } from "../db/schema.js";
import { requirePermission } from "../lib/permissions.js";
import { recordAuditEvent } from "../lib/audit.js";

// MIDAD Phase A' — Customer entity. Company-wide directory (not
// project-scoped), same shape/discipline as suppliers.ts: minimal master
// data, no delete route, owner-gated mutations, member-open reads. See
// db/schema.ts's comment above the `customers` table for the full
// architectural rationale (why this is additive and never touches
// clientName on projects/invoices/quotes).
export const customersRouter = Router();

customersRouter.get("/", async (req: Request, res: Response) => {
  const rows = await db.query.customers.findMany({
    where: eq(customers.companyId, req.companyId!),
    orderBy: (c, { asc }) => [asc(c.name)],
  });
  res.json(rows);
});

const createSchema = z.object({
  name: z.string().min(2, "الاسم قصير جداً"),
  contactName: z.string().optional(),
  taxId: z.string().optional(),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().optional(),
  address: z.string().optional(),
  notes: z.string().optional(),
});

customersRouter.post("/", requirePermission("customer.manage"), async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const customer = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(customers)
      .values({
        companyId: req.companyId!,
        name: parsed.data.name,
        contactName: parsed.data.contactName,
        taxId: parsed.data.taxId,
        email: parsed.data.email || undefined,
        phone: parsed.data.phone,
        address: parsed.data.address,
        notes: parsed.data.notes,
        createdBy: req.userId!,
      })
      .returning();

    await recordAuditEvent(tx, {
      companyId: req.companyId!,
      actorUserId: req.userId!,
      action: "customer.created",
      entityType: "customer",
      entityId: created.id,
      afterValue: created,
    });

    return created;
  });

  res.status(201).json(customer);
});

async function findOwnedCustomer(companyId: string, customerId: string) {
  return db.query.customers.findFirst({
    where: and(eq(customers.id, customerId), eq(customers.companyId, companyId)),
  });
}

// Includes this customer's linked projects (read-only, id/name/status
// only — never a second source of truth for a project's own fields) so
// the "unified customer profile with related projects" gap is actually
// closed, not just a bare CRUD form.
customersRouter.get("/:id", async (req: Request<{ id: string }>, res: Response) => {
  const customer = await findOwnedCustomer(req.companyId!, req.params.id);
  if (!customer) return res.status(404).json({ error: "العميل غير موجود" });

  const relatedProjects = await db.query.projects.findMany({
    where: and(eq(projects.customerId, customer.id), eq(projects.companyId, req.companyId!)),
    columns: { id: true, name: true, status: true },
    orderBy: (p, { desc }) => [desc(p.createdAt)],
  });

  res.json({ ...customer, projects: relatedProjects });
});

const updateSchema = z.object({
  name: z.string().min(2).optional(),
  contactName: z.string().optional(),
  taxId: z.string().optional(),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().optional(),
  address: z.string().optional(),
  notes: z.string().optional(),
  status: z.enum(["active", "inactive"]).optional(),
});

customersRouter.patch(
  "/:id",
  requirePermission("customer.manage"),
  async (req: Request<{ id: string }>, res: Response) => {
    const existing = await findOwnedCustomer(req.companyId!, req.params.id);
    if (!existing) return res.status(404).json({ error: "العميل غير موجود" });

    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

    const { email, ...rest } = parsed.data;
    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(customers)
        .set({
          ...rest,
          ...(email !== undefined ? { email: email || null } : {}),
          updatedAt: new Date(),
        })
        .where(eq(customers.id, existing.id))
        .returning();

      await recordAuditEvent(tx, {
        companyId: req.companyId!,
        actorUserId: req.userId!,
        action: "customer.updated",
        entityType: "customer",
        entityId: existing.id,
        beforeValue: existing,
        afterValue: row,
      });

      return row;
    });

    res.json(updated);
  },
);
