import { Router, type Request, type Response, type NextFunction } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { laborAllocations, laborCostPostings, projects } from "../db/schema.js";
import { roundMoney, sumMoney } from "../lib/money.js";

type ProjectParams = { projectId: string };

// MIDAD Phase A4/A5.1 — read-only project labor cost visibility.
// Deliberately NOT part of Actual Cost/Budget/Forecast/Cash Flow: this
// never reads or writes `expenses` — the real Actual Cost contribution of
// a posted allocation lives entirely in the project's own Expense/Actual
// Cost total (see routes/laborCost*.ts and schema.ts's comment on
// `labor_cost_postings`). This endpoint answers a narrower question —
// "of the labor cost allocated to this project, how much has actually
// been posted?" — using `labor_cost_postings` as the sole source of
// posting provenance (never inferred from Expense rows existing, since an
// Expense alone can't be traced back to the allocation that produced it).
//
// A posting is only counted as currently "posted" if it has kind="posting"
// AND no `labor_cost_postings` row with kind="reversal" points back at it
// via reversalOfPostingId — a reversed posting's net Actual Cost effect is
// zero, so it must read back as unposted here too, never as still-posted.
export const laborCostRouter = Router({ mergeParams: true });

// Same tenant/ownership-scoping pattern as every other project sub-resource.
laborCostRouter.use(async (req: Request<ProjectParams>, res: Response, next: NextFunction) => {
  const project = await db.query.projects.findFirst({
    where: and(eq(projects.id, req.params.projectId), eq(projects.companyId, req.companyId!)),
  });
  if (!project) return res.status(404).json({ error: "المشروع غير موجود" });
  next();
});

laborCostRouter.get("/", async (req: Request<ProjectParams>, res: Response) => {
  const allocations = await db
    .select({ id: laborAllocations.id, amount: laborAllocations.amount })
    .from(laborAllocations)
    .where(and(eq(laborAllocations.projectId, req.params.projectId), eq(laborAllocations.companyId, req.companyId!)));

  // The allocation ids above are already proven to belong to this company
  // (same transitive-scoping reasoning laborAllocations.ts's own create()
  // route documents for payrollRecordId) — the companyId filter here is
  // additional defense-in-depth, not the only guard.
  const allocationIds = allocations.map((a) => a.id);
  const postings = allocationIds.length
    ? await db
        .select({
          id: laborCostPostings.id,
          laborAllocationId: laborCostPostings.laborAllocationId,
          kind: laborCostPostings.kind,
          reversalOfPostingId: laborCostPostings.reversalOfPostingId,
        })
        .from(laborCostPostings)
        .where(and(inArray(laborCostPostings.laborAllocationId, allocationIds), eq(laborCostPostings.companyId, req.companyId!)))
    : [];

  const reversedPostingIds = new Set(
    postings.filter((p) => p.kind === "reversal" && p.reversalOfPostingId).map((p) => p.reversalOfPostingId as string),
  );
  const activelyPostedAllocationIds = new Set(
    postings.filter((p) => p.kind === "posting" && !reversedPostingIds.has(p.id)).map((p) => p.laborAllocationId),
  );

  const allocatedTotal = sumMoney(allocations.map((a) => Number(a.amount)));
  const postedTotal = sumMoney(
    allocations.filter((a) => activelyPostedAllocationIds.has(a.id)).map((a) => Number(a.amount)),
  );
  const unpostedTotal = roundMoney(allocatedTotal - postedTotal);

  res.json({
    projectId: req.params.projectId,
    allocatedTotal,
    allocationCount: allocations.length,
    postedTotal,
    unpostedTotal,
    posted: allocations.length > 0 && unpostedTotal === 0,
  });
});
