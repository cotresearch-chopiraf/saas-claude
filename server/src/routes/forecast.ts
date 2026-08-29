import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { and, eq, lte, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  budgetItems,
  commitmentLines,
  commitments,
  contracts,
  expenses,
  forecastSnapshots,
  ipcs,
  projects,
  type ForecastSnapshotAssumptions,
} from "../db/schema.js";
import { requirePermission } from "../lib/permissions.js";
import { recordAuditEvent } from "../lib/audit.js";
import { sumMoney } from "../lib/money.js";
import { calculateForecast, type ForecastMethod } from "../lib/forecast.js";

type ProjectParams = { projectId: string };
type SnapshotParams = ProjectParams & { snapshotId: string };

export const forecastRouter = Router({ mergeParams: true });

// Same tenant/ownership-scoping pattern as every other project sub-resource.
forecastRouter.use(async (req: Request<ProjectParams>, res: Response, next: NextFunction) => {
  const project = await db.query.projects.findFirst({
    where: and(eq(projects.id, req.params.projectId), eq(projects.companyId, req.companyId!)),
  });
  if (!project) return res.status(404).json({ error: "المشروع غير موجود" });
  next();
});

export function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

// A project's "home currency" for Forecast purposes: its main contract's
// currency (the commercial instrument that actually defines what currency
// this project is denominated in), defaulting to "SAR" — the same default
// every other domain uses — when no main contract exists yet. budgetItems
// and expenses carry no currency column at all (single-currency by
// construction), so this determination only matters for filtering
// Commitments, the one place a genuinely different currency can be entered
// (see docs/MIDAD_FORECAST_MODEL.md's Currency section).
async function determineProjectCurrency(companyId: string, projectId: string): Promise<string> {
  const mainContract = await db.query.contracts.findFirst({
    where: and(
      eq(contracts.projectId, projectId),
      eq(contracts.companyId, companyId),
      eq(contracts.contractType, "main"),
    ),
    orderBy: (c, { asc }) => [asc(c.createdAt)],
  });
  return mainContract?.currency ?? "SAR";
}

export interface CollectedInputs {
  costPlan: number;
  actualCost: number;
  committedCost: number;
  certifiedValue: number;
  currency: string;
  excludedForeignCurrencyCommitmentIds: string[];
}

// Collects the four canonical Forecast inputs from their canonical sources
// only, each independently re-scoped to (companyId, projectId) — never
// trusting that a project id alone is enough. asOfDate is a cutoff, not a
// full point-in-time reconstruction of every source: see
// docs/MIDAD_FORECAST_MODEL.md's PIT section for exactly what each cutoff
// means and why it is exact for each source.
//
// Exported for routes/cashflow.ts (Phase 2E): Cash Flow's ETC and
// committed-cost figures must be this exact same computation, never a
// second, independent derivation of BAC/AC/committedCost — see
// docs/MIDAD_CASHFLOW_MODEL.md.
export async function collectForecastInputs(
  companyId: string,
  projectId: string,
  asOfDate: string,
): Promise<CollectedInputs> {
  const cutoff = new Date(`${asOfDate}T23:59:59.999Z`);
  const currency = await determineProjectCurrency(companyId, projectId);

  // Cost Plan (BAC) — the current full plan, not cutoff-filtered: a plan
  // baseline is not a dated transaction (see docs/MIDAD_FORECAST_MODEL.md).
  const budgetRows = await db
    .select({ amount: budgetItems.plannedAmount })
    .from(budgetItems)
    .where(eq(budgetItems.projectId, projectId));
  const costPlan = sumMoney(budgetRows.map((r) => Number(r.amount)));

  // Actual Cost (AC) — expenses dated on/before the cutoff.
  const expenseRows = await db
    .select({ amount: expenses.amount })
    .from(expenses)
    .where(and(eq(expenses.projectId, projectId), lte(expenses.expenseDate, asOfDate)));
  const actualCost = sumMoney(expenseRows.map((r) => Number(r.amount)));

  // Committed Cost — only commitments that had already reached
  // active/partially_fulfilled/closed by the cutoff (never draft/
  // cancelled), summed from their lines' own createdAt <= cutoff. Because
  // commitment lines are strictly append-only once a commitment leaves
  // draft (submit() freezes the initial set; amend() only ever adds more),
  // this reconstructs the exact committed amount as of the cutoff, not
  // just the current total. Only lines in the project's determined
  // currency are counted — a commitment in a different currency is
  // excluded, never summed as if it were the same unit.
  const eligibleCommitmentStatus = sql`${commitments.status} IN ('active', 'partially_fulfilled', 'closed')`;
  const committedRows = await db
    .select({ amount: commitmentLines.amount })
    .from(commitmentLines)
    .innerJoin(commitments, eq(commitmentLines.commitmentId, commitments.id))
    .where(
      and(
        eq(commitments.projectId, projectId),
        eq(commitments.companyId, companyId),
        eligibleCommitmentStatus,
        sql`${commitments.approvedAt} IS NOT NULL`,
        lte(commitments.approvedAt, cutoff),
        lte(commitmentLines.createdAt, cutoff),
        eq(commitments.currency, currency),
      ),
    );
  const committedCost = sumMoney(committedRows.map((r) => Number(r.amount)));

  const excludedRows = await db
    .selectDistinct({ id: commitments.id })
    .from(commitments)
    .where(
      and(
        eq(commitments.projectId, projectId),
        eq(commitments.companyId, companyId),
        eligibleCommitmentStatus,
        sql`${commitments.approvedAt} IS NOT NULL`,
        lte(commitments.approvedAt, cutoff),
        sql`${commitments.currency} != ${currency}`,
      ),
    );

  // Certified Progress — gross certified value of IPCs actually certified
  // on/before the cutoff. draft/submitted/approved/rejected IPCs never
  // count; certify() freezes this value forever, so it is exact.
  const certifiedRows = await db
    .select({ amount: ipcs.grossValue })
    .from(ipcs)
    .where(
      and(
        eq(ipcs.projectId, projectId),
        eq(ipcs.companyId, companyId),
        eq(ipcs.status, "certified"),
        sql`${ipcs.certifiedAt} IS NOT NULL`,
        lte(ipcs.certifiedAt, cutoff),
      ),
    );
  const certifiedValue = sumMoney(certifiedRows.map((r) => Number(r.amount ?? 0)));

  return {
    costPlan,
    actualCost,
    committedCost,
    certifiedValue,
    currency,
    excludedForeignCurrencyCommitmentIds: excludedRows.map((r) => r.id),
  };
}

// Computed, not persisted — always "as of now" (today). No audit event: an
// ordinary GET produces no durable record, matching the instruction not to
// manufacture audit rows for reads.
forecastRouter.get("/", async (req: Request<ProjectParams>, res: Response) => {
  const asOfDate = todayStr();
  const inputs = await collectForecastInputs(req.companyId!, req.params.projectId, asOfDate);

  const methods: ForecastMethod[] = ["cost_to_complete", "commitment_aware"];
  const results = Object.fromEntries(methods.map((m) => [m, calculateForecast(m, inputs)]));

  res.json({
    projectId: req.params.projectId,
    asOfDate,
    currency: inputs.currency,
    excludedForeignCurrencyCommitmentIds: inputs.excludedForeignCurrencyCommitmentIds,
    methods: results,
  });
});

const snapshotSchema = z.object({
  method: z.enum(["cost_to_complete", "commitment_aware"]),
  asOfDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "تنسيق التاريخ غير صحيح")
    .optional(),
  notes: z.string().optional(),
});

// Creates one immutable snapshot for ONE chosen method. The read (collect
// inputs) and the write (insert the snapshot) happen inside a single
// REPEATABLE READ transaction so the persisted numbers reflect one
// consistent calculation boundary, not values drifting between statements
// if another request mutates Expenses/Commitments/IPCs concurrently.
forecastRouter.post(
  "/snapshots",
  requirePermission("forecast.manage"),
  async (req: Request<ProjectParams>, res: Response) => {
    const parsed = snapshotSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

    const asOfDate = parsed.data.asOfDate ?? todayStr();
    if (asOfDate > todayStr()) {
      return res.status(400).json({ error: "لا يمكن أن يكون تاريخ اللقطة في المستقبل" });
    }

    const snapshot = await db.transaction(
      async (tx) => {
        const inputs = await collectForecastInputs(req.companyId!, req.params.projectId, asOfDate);
        const calc = calculateForecast(parsed.data.method, inputs);

        const assumptions: ForecastSnapshotAssumptions = {
          excludedForeignCurrencyCommitmentIds: inputs.excludedForeignCurrencyCommitmentIds,
        };

        const [inserted] = await tx
          .insert(forecastSnapshots)
          .values({
            companyId: req.companyId!,
            projectId: req.params.projectId,
            asOfDate,
            method: calc.method,
            currency: inputs.currency,
            costPlan: String(calc.costPlan),
            actualCost: String(calc.actualCost),
            committedCost: String(calc.committedCost),
            certifiedValue: String(calc.certifiedValue),
            remainingCost: String(calc.remainingCost),
            etc: String(calc.etc),
            eac: String(calc.eac),
            variance: String(calc.variance),
            variancePercent: calc.variancePercent === null ? null : String(calc.variancePercent),
            assumptions,
            notes: parsed.data.notes ?? null,
            createdBy: req.userId!,
          })
          .returning();

        await recordAuditEvent(tx, {
          companyId: req.companyId!,
          actorUserId: req.userId!,
          action: "forecast.snapshotGenerated",
          entityType: "forecast_snapshot",
          entityId: inserted.id,
          afterValue: inserted,
          metadata: {
            projectId: req.params.projectId,
            method: calc.method,
            asOfDate,
            eac: calc.eac,
            etc: calc.etc,
          },
        });

        return inserted;
      },
      { isolationLevel: "repeatable read" },
    );

    res.status(201).json(snapshot);
  },
);

forecastRouter.get("/snapshots", async (req: Request<ProjectParams>, res: Response) => {
  const rows = await db.query.forecastSnapshots.findMany({
    where: and(
      eq(forecastSnapshots.projectId, req.params.projectId),
      eq(forecastSnapshots.companyId, req.companyId!),
    ),
    orderBy: (s, { desc }) => [desc(s.createdAt)],
  });
  res.json(rows);
});

forecastRouter.get("/snapshots/:snapshotId", async (req: Request<SnapshotParams>, res: Response) => {
  const snapshot = await db.query.forecastSnapshots.findFirst({
    where: and(
      eq(forecastSnapshots.id, req.params.snapshotId),
      eq(forecastSnapshots.projectId, req.params.projectId),
      eq(forecastSnapshots.companyId, req.companyId!),
    ),
  });
  if (!snapshot) return res.status(404).json({ error: "لقطة التوقعات غير موجودة" });
  res.json(snapshot);
});
