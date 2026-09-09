import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { employees } from "../db/schema.js";
import { requirePermission } from "../lib/permissions.js";
import { recordAuditEvent } from "../lib/audit.js";
import { pgErrorInfo } from "../lib/pgError.js";

// MIDAD Phase A2 — Employees CRUD. Company-wide workforce directory (not
// project-scoped), same shape/discipline as suppliers.ts/customers.ts:
// minimal master data, no delete route (lifecycle is active/inactive via
// PATCH), mutations gated by workforce.manage, reads member-open — same
// read/write split every other domain in this matrix already uses (see
// permissions.ts's own comment on why this codebase doesn't invent a
// second, finer-grained read authorization tier).
//
// Deliberately does NOT read or write nationality/bankName/iban (added in
// A1 for a future Mudad/WPS-facing slice) — this slice only touches the
// A2 master-data fields (employeeNumber/name/jobTitle/hireDate/phone/
// email/status).
export const employeesRouter = Router();

employeesRouter.get("/", async (req: Request, res: Response) => {
  const rows = await db.query.employees.findMany({
    where: eq(employees.companyId, req.companyId!),
    orderBy: (e, { asc }) => [asc(e.name)],
  });
  res.json(rows);
});

const createSchema = z.object({
  name: z.string().min(2, "الاسم قصير جداً"),
  employeeNumber: z.string().min(1, "رقم الموظف مطلوب"),
  jobTitle: z.string().optional(),
  hireDate: z.string().optional(),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().optional(),
});

employeesRouter.post("/", requirePermission("workforce.manage"), async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  try {
    const employee = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(employees)
        .values({
          companyId: req.companyId!,
          employeeNumber: parsed.data.employeeNumber,
          name: parsed.data.name,
          jobTitle: parsed.data.jobTitle,
          hireDate: parsed.data.hireDate,
          email: parsed.data.email || undefined,
          phone: parsed.data.phone,
          createdBy: req.userId!,
        })
        .returning();

      await recordAuditEvent(tx, {
        companyId: req.companyId!,
        actorUserId: req.userId!,
        action: "employee.created",
        entityType: "employee",
        entityId: created.id,
        afterValue: created,
      });

      return created;
    });

    res.status(201).json(employee);
  } catch (err) {
    if (pgErrorInfo(err).code === "23505") {
      return res.status(409).json({ error: "رقم الموظف مستخدم مسبقاً" });
    }
    throw err;
  }
});

async function findOwnedEmployee(companyId: string, employeeId: string) {
  return db.query.employees.findFirst({
    where: and(eq(employees.id, employeeId), eq(employees.companyId, companyId)),
  });
}

employeesRouter.get("/:id", async (req: Request<{ id: string }>, res: Response) => {
  const employee = await findOwnedEmployee(req.companyId!, req.params.id);
  if (!employee) return res.status(404).json({ error: "الموظف غير موجود" });
  res.json(employee);
});

const updateSchema = z.object({
  name: z.string().min(2).optional(),
  employeeNumber: z.string().min(1).optional(),
  jobTitle: z.string().optional(),
  hireDate: z.string().optional(),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().optional(),
  status: z.enum(["active", "inactive"]).optional(),
});

employeesRouter.patch(
  "/:id",
  requirePermission("workforce.manage"),
  async (req: Request<{ id: string }>, res: Response) => {
    const existing = await findOwnedEmployee(req.companyId!, req.params.id);
    if (!existing) return res.status(404).json({ error: "الموظف غير موجود" });

    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

    const { email, ...rest } = parsed.data;

    try {
      const updated = await db.transaction(async (tx) => {
        const [row] = await tx
          .update(employees)
          .set({
            ...rest,
            ...(email !== undefined ? { email: email || null } : {}),
            updatedAt: new Date(),
          })
          .where(eq(employees.id, existing.id))
          .returning();

        // A status change gets its own, more specific audit action (still
        // one canonical audit table — see audit.ts's own header comment —
        // this only chooses a more descriptive `action` string, the same
        // way invoice.markPaid is distinct from a generic invoice update
        // elsewhere in this matrix) so the activity log reads as "employee
        // deactivated" rather than an opaque generic "updated".
        const action =
          parsed.data.status && parsed.data.status !== existing.status
            ? parsed.data.status === "active"
              ? "employee.activated"
              : "employee.deactivated"
            : "employee.updated";

        await recordAuditEvent(tx, {
          companyId: req.companyId!,
          actorUserId: req.userId!,
          action,
          entityType: "employee",
          entityId: existing.id,
          beforeValue: existing,
          afterValue: row,
        });

        return row;
      });

      res.json(updated);
    } catch (err) {
      if (pgErrorInfo(err).code === "23505") {
        return res.status(409).json({ error: "رقم الموظف مستخدم مسبقاً" });
      }
      throw err;
    }
  },
);
