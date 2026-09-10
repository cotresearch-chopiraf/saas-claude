import { Router, type Request, type Response, type NextFunction } from "express";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { laborAllocations, projects } from "../db/schema.js";
import { sumMoney } from "../lib/money.js";

type ProjectParams = { projectId: string };

// MIDAD Phase A4 — read-only project labor cost visibility. Deliberately
// NOT part of Actual Cost/Budget/Forecast/Cash Flow: routes/
// laborAllocations.ts never writes to `expenses` (financial posting is
// reserved for a future, separately authorized slice — see that file's
// own header comment), so this total is pre-posting, internal allocation
// data. `posted: false` is always present in the response specifically so
// no client can accidentally render this next to Actual Cost without the
// caller seeing that distinction in the data itself, not just in UI copy.
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
  const rows = await db
    .select({ amount: laborAllocations.amount })
    .from(laborAllocations)
    .where(and(eq(laborAllocations.projectId, req.params.projectId), eq(laborAllocations.companyId, req.companyId!)));

  res.json({
    projectId: req.params.projectId,
    allocatedTotal: sumMoney(rows.map((r) => Number(r.amount))),
    allocationCount: rows.length,
    posted: false,
  });
});
