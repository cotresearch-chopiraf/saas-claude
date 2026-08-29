import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { suppliers } from "../db/schema.js";
import { requirePermission } from "../lib/permissions.js";
import { recordAuditEvent } from "../lib/audit.js";

export const suppliersRouter = Router();

// Company-wide directory (not project-scoped) — a supplier/subcontractor
// is registered once and reused across every project's commitments.
suppliersRouter.get("/", async (req: Request, res: Response) => {
  const rows = await db.query.suppliers.findMany({
    where: eq(suppliers.companyId, req.companyId!),
    orderBy: (s, { asc }) => [asc(s.name)],
  });
  res.json(rows);
});

const createSchema = z.object({
  name: z.string().min(2, "الاسم قصير جداً"),
  type: z.enum(["supplier", "subcontractor"]),
  taxId: z.string().optional(),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().optional(),
  address: z.string().optional(),
});

suppliersRouter.post("/", requirePermission("supplier.manage"), async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const supplier = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(suppliers)
      .values({
        companyId: req.companyId!,
        name: parsed.data.name,
        type: parsed.data.type,
        taxId: parsed.data.taxId,
        email: parsed.data.email || undefined,
        phone: parsed.data.phone,
        address: parsed.data.address,
        createdBy: req.userId!,
      })
      .returning();

    await recordAuditEvent(tx, {
      companyId: req.companyId!,
      actorUserId: req.userId!,
      action: "supplier.created",
      entityType: "supplier",
      entityId: created.id,
      afterValue: created,
    });

    return created;
  });

  res.status(201).json(supplier);
});

async function findOwnedSupplier(companyId: string, supplierId: string) {
  return db.query.suppliers.findFirst({
    where: and(eq(suppliers.id, supplierId), eq(suppliers.companyId, companyId)),
  });
}

suppliersRouter.get("/:id", async (req: Request<{ id: string }>, res: Response) => {
  const supplier = await findOwnedSupplier(req.companyId!, req.params.id);
  if (!supplier) return res.status(404).json({ error: "المورد غير موجود" });
  res.json(supplier);
});

const updateSchema = z.object({
  name: z.string().min(2).optional(),
  taxId: z.string().optional(),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().optional(),
  address: z.string().optional(),
  status: z.enum(["active", "inactive"]).optional(),
});

suppliersRouter.patch(
  "/:id",
  requirePermission("supplier.manage"),
  async (req: Request<{ id: string }>, res: Response) => {
    const existing = await findOwnedSupplier(req.companyId!, req.params.id);
    if (!existing) return res.status(404).json({ error: "المورد غير موجود" });

    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

    const { email, ...rest } = parsed.data;
    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(suppliers)
        .set({
          ...rest,
          ...(email !== undefined ? { email: email || null } : {}),
          updatedAt: new Date(),
        })
        .where(eq(suppliers.id, existing.id))
        .returning();

      await recordAuditEvent(tx, {
        companyId: req.companyId!,
        actorUserId: req.userId!,
        action: "supplier.updated",
        entityType: "supplier",
        entityId: existing.id,
        beforeValue: existing,
        afterValue: row,
      });

      return row;
    });

    res.json(updated);
  },
);
