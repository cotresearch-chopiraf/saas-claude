import { Router, type Request, type Response } from "express";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { laborCostPostings, expenses } from "../db/schema.js";
import { requirePermission } from "../lib/permissions.js";
import { recordAuditEvent } from "../lib/audit.js";
import { pgErrorInfo } from "../lib/pgError.js";
import { roundMoney } from "../lib/money.js";

// MIDAD Phase A5 — Labor Cost Postings. Read-only listing (any company
// member — same posture as GET /labor-allocations) plus the one
// controlled mutation this domain allows post-posting: an additive
// reversal. Nothing here ever UPDATEs or DELETEs an existing
// `labor_cost_postings` or `expenses` row — see schema.ts's own comment
// on this table for why (the same "amend by adding, never by
// overwriting" discipline commitments.ts's amend() already uses).
export const laborCostPostingsRouter = Router();

laborCostPostingsRouter.get("/", async (req: Request, res: Response) => {
  const payrollPeriodId = typeof req.query.payrollPeriodId === "string" ? req.query.payrollPeriodId : undefined;
  const laborAllocationId = typeof req.query.laborAllocationId === "string" ? req.query.laborAllocationId : undefined;

  const conditions = [eq(laborCostPostings.companyId, req.companyId!)];
  if (payrollPeriodId) conditions.push(eq(laborCostPostings.payrollPeriodId, payrollPeriodId));
  if (laborAllocationId) conditions.push(eq(laborCostPostings.laborAllocationId, laborAllocationId));

  const rows = await db.query.laborCostPostings.findMany({
    where: and(...conditions),
    with: {
      expense: { columns: { id: true, amount: true, expenseDate: true, description: true } },
      laborAllocation: {
        with: {
          project: { columns: { id: true, name: true } },
          costCode: { columns: { id: true, code: true, name: true } },
        },
      },
    },
    orderBy: (p, { asc }) => [asc(p.postedAt)],
  });
  res.json(rows);
});

async function findOwnedPosting(companyId: string, id: string) {
  return db.query.laborCostPostings.findFirst({
    where: and(eq(laborCostPostings.id, id), eq(laborCostPostings.companyId, companyId)),
  });
}

laborCostPostingsRouter.get("/:id", async (req: Request<{ id: string }>, res: Response) => {
  const posting = await findOwnedPosting(req.companyId!, req.params.id);
  if (!posting) return res.status(404).json({ error: "سجل الترحيل غير موجود" });
  res.json(posting);
});

// Never modifies or deletes the original Expense/posting — inserts a NEW
// negative-amount Expense plus a NEW labor_cost_postings row with
// kind="reversal", linked back via reversalOfPostingId. Net financial
// effect on Actual Cost is 0 (original +X, reversal -X), and the complete
// history of both rows remains queryable forever.
laborCostPostingsRouter.post(
  "/:id/reverse",
  requirePermission("payroll.post"),
  async (req: Request<{ id: string }>, res: Response) => {
    const existing = await findOwnedPosting(req.companyId!, req.params.id);
    if (!existing) return res.status(404).json({ error: "سجل الترحيل غير موجود" });

    try {
      const result = await db.transaction(async (tx) => {
        // Lock the posting row itself so two concurrent reversal attempts
        // on the same posting can never both pass the "not already
        // reversed" check — same pattern payrollPeriods.ts's post() uses
        // on the period row. The partial unique index on
        // reversalOfPostingId (schema.ts) is the DB-level backstop under
        // this lock, not a substitute for it.
        const [locked] = await tx.select().from(laborCostPostings).where(eq(laborCostPostings.id, existing.id)).for("update");
        if (!locked) return { outcome: "notFound" as const };
        if (locked.kind !== "posting") return { outcome: "notAPosting" as const };

        const [alreadyReversed] = await tx
          .select({ id: laborCostPostings.id })
          .from(laborCostPostings)
          .where(and(eq(laborCostPostings.reversalOfPostingId, locked.id), eq(laborCostPostings.kind, "reversal")));
        if (alreadyReversed) return { outcome: "alreadyReversed" as const };

        const [originalExpense] = await tx.select().from(expenses).where(eq(expenses.id, locked.expenseId));
        if (!originalExpense) return { outcome: "notFound" as const };

        const [reversalExpense] = await tx
          .insert(expenses)
          .values({
            projectId: originalExpense.projectId,
            costCodeId: originalExpense.costCodeId,
            description: `عكس ترحيل تكلفة عمالة — ${originalExpense.description}`,
            amount: String(roundMoney(-Number(originalExpense.amount))),
            expenseDate: originalExpense.expenseDate,
          })
          .returning();

        const [reversal] = await tx
          .insert(laborCostPostings)
          .values({
            companyId: req.companyId!,
            payrollPeriodId: locked.payrollPeriodId,
            laborAllocationId: locked.laborAllocationId,
            expenseId: reversalExpense.id,
            kind: "reversal",
            reversalOfPostingId: locked.id,
            postedBy: req.userId!,
          })
          .returning();

        await recordAuditEvent(tx, {
          companyId: req.companyId!,
          actorUserId: req.userId!,
          action: "laborCostPosting.reversed",
          entityType: "labor_cost_posting",
          entityId: locked.id,
          metadata: { reversalPostingId: reversal.id, reversalExpenseId: reversalExpense.id },
        });

        await recordAuditEvent(tx, {
          companyId: req.companyId!,
          actorUserId: req.userId!,
          action: "laborCostPosting.created",
          entityType: "labor_cost_posting",
          entityId: reversal.id,
          afterValue: reversal,
          metadata: {
            kind: "reversal",
            reversalOfPostingId: locked.id,
            laborAllocationId: locked.laborAllocationId,
            expenseId: reversalExpense.id,
            amount: reversalExpense.amount,
          },
        });

        return { outcome: "ok" as const, reversal, reversalExpense };
      });

      if (result.outcome === "notFound") return res.status(404).json({ error: "سجل الترحيل غير موجود" });
      if (result.outcome === "notAPosting") return res.status(400).json({ error: "لا يمكن عكس سجل عكس ترحيل" });
      if (result.outcome === "alreadyReversed") return res.status(409).json({ error: "تم عكس هذا الترحيل بالفعل" });
      res.status(201).json({ reversal: result.reversal, expense: result.reversalExpense });
    } catch (err) {
      if (pgErrorInfo(err).code === "23505") {
        return res.status(409).json({ error: "تم عكس هذا الترحيل بالفعل" });
      }
      throw err;
    }
  },
);
