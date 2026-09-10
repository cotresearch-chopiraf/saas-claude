import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { and, desc, eq, lte, ne, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { budgetAlerts, budgetItems, commitmentLines, commitments, expenses, projects } from "../db/schema.js";
import { requirePermission } from "../lib/permissions.js";
import { recordAuditEvent } from "../lib/audit.js";
import { sumMoney } from "../lib/money.js";
import { calculateForecast } from "../lib/forecast.js";
import { collectForecastInputs, todayStr } from "./forecast.js";
import {
  buildDeduplicationKey,
  evaluateActualCommitmentsOverBudgetRule,
  evaluateBudgetConsumptionRule,
  evaluateCostCodeRiskRule,
  evaluateForecastOverBudgetRule,
  type AlertHit,
} from "../lib/budgetAlerts.js";

export const budgetAlertsRouter = Router();

// Company-wide mount (/api/budget-alerts), same pattern as
// workforce-compliance: alerts span multiple projects (the dashboard needs
// a cross-project view), so — unlike Forecast/Commitments/Measurements —
// this is never nested under /api/projects/:projectId/. Every route below
// still scopes every query by req.companyId!, and any projectId supplied by
// the caller (query or body) is independently validated to belong to that
// company before being trusted — never assumed safe merely because it
// parses as a UUID.

async function findOwnedProject(companyId: string, projectId: string) {
  return db.query.projects.findFirst({ where: and(eq(projects.id, projectId), eq(projects.companyId, companyId)) });
}

// Grouped-by-cost-code equivalent of routes/forecast.ts's own
// collectForecastInputs — same canonical sources (budgetItems.plannedAmount,
// expenses.amount, commitmentLines.amount via the identical eligible-
// commitment filter that function uses), just aggregated per costCodeId
// instead of per project. Never a second calculation engine: this is the
// same SUM(...) logic, scoped one level finer, using grouped aggregation
// queries (not a per-cost-code loop) to stay N+1-free.
async function collectCostCodeInputs(
  companyId: string,
  projectId: string,
  asOfDate: string,
  currency: string,
): Promise<Map<string, { costCodeBudget: number; costCodeActual: number; costCodeCommitted: number }>> {
  const cutoff = new Date(`${asOfDate}T23:59:59.999Z`);

  const budgetRows = await db
    .select({ costCodeId: budgetItems.costCodeId, amount: budgetItems.plannedAmount })
    .from(budgetItems)
    .where(and(eq(budgetItems.projectId, projectId), sql`${budgetItems.costCodeId} IS NOT NULL`));

  const actualRows = await db
    .select({ costCodeId: expenses.costCodeId, amount: expenses.amount })
    .from(expenses)
    .where(
      and(
        eq(expenses.projectId, projectId),
        sql`${expenses.costCodeId} IS NOT NULL`,
        lte(expenses.expenseDate, asOfDate),
      ),
    );

  // Same eligibility filter as collectForecastInputs (routes/forecast.ts):
  // active/partially_fulfilled/closed, approved on/before the cutoff, lines
  // created on/before the cutoff, and only the project's own currency.
  const committedRows = await db
    .select({ costCodeId: commitmentLines.costCodeId, amount: commitmentLines.amount })
    .from(commitmentLines)
    .innerJoin(commitments, eq(commitmentLines.commitmentId, commitments.id))
    .where(
      and(
        eq(commitments.projectId, projectId),
        eq(commitments.companyId, companyId),
        sql`${commitments.status} IN ('active', 'partially_fulfilled', 'closed')`,
        sql`${commitments.approvedAt} IS NOT NULL`,
        lte(commitments.approvedAt, cutoff),
        lte(commitmentLines.createdAt, cutoff),
        eq(commitments.currency, currency),
        sql`${commitmentLines.costCodeId} IS NOT NULL`,
      ),
    );

  const buckets = new Map<string, { budget: number[]; actual: number[]; committed: number[] }>();
  function bucket(id: string) {
    let b = buckets.get(id);
    if (!b) {
      b = { budget: [], actual: [], committed: [] };
      buckets.set(id, b);
    }
    return b;
  }
  for (const r of budgetRows) if (r.costCodeId) bucket(r.costCodeId).budget.push(Number(r.amount));
  for (const r of actualRows) if (r.costCodeId) bucket(r.costCodeId).actual.push(Number(r.amount));
  for (const r of committedRows) if (r.costCodeId) bucket(r.costCodeId).committed.push(Number(r.amount));

  const result = new Map<string, { costCodeBudget: number; costCodeActual: number; costCodeCommitted: number }>();
  for (const [id, b] of buckets) {
    result.set(id, {
      costCodeBudget: sumMoney(b.budget),
      costCodeActual: sumMoney(b.actual),
      costCodeCommitted: sumMoney(b.committed),
    });
  }
  return result;
}

interface PersistCandidate {
  hit: AlertHit;
  costCodeId: string | null;
  snapshot: { budgetAmount: number | null; actualAmount: number | null; commitmentAmount: number | null; forecastAmount: number | null };
  currency: string;
}

// Idempotent, concurrency-safe insert for one project's rule hits. The
// partial unique index (budget_alerts_open_dedup_unique) is the actual
// guarantee: two simultaneous evaluate() calls each attempt the same
// INSERT ... ON CONFLICT DO NOTHING, and only one can ever win per
// (company, project, deduplicationKey) among non-resolved rows — no
// frontend button-disabling required. recordAuditEvent only runs for rows
// that genuinely inserted, never for a no-op conflict, so repeated
// evaluation (e.g. every dashboard load) never spams the audit trail.
async function persistCandidates(
  companyId: string,
  projectId: string,
  actorUserId: string,
  candidates: PersistCandidate[],
) {
  const created: (typeof budgetAlerts.$inferSelect)[] = [];
  if (candidates.length === 0) return created;

  await db.transaction(async (tx) => {
    for (const candidate of candidates) {
      const deduplicationKey = buildDeduplicationKey(candidate.hit, candidate.costCodeId);
      const [inserted] = await tx
        .insert(budgetAlerts)
        .values({
          companyId,
          projectId,
          costCodeId: candidate.costCodeId,
          ruleCode: candidate.hit.ruleCode,
          severity: candidate.hit.severity,
          status: "open",
          metricType: candidate.hit.metricType,
          metricValue: String(candidate.hit.metricValue),
          thresholdValue: String(candidate.hit.thresholdValue),
          budgetAmount: candidate.snapshot.budgetAmount !== null ? String(candidate.snapshot.budgetAmount) : null,
          actualAmount: candidate.snapshot.actualAmount !== null ? String(candidate.snapshot.actualAmount) : null,
          commitmentAmount: candidate.snapshot.commitmentAmount !== null ? String(candidate.snapshot.commitmentAmount) : null,
          forecastAmount: candidate.snapshot.forecastAmount !== null ? String(candidate.snapshot.forecastAmount) : null,
          currency: candidate.currency,
          title: candidate.hit.title,
          description: candidate.hit.description,
          recommendedAction: candidate.hit.recommendedAction,
          deduplicationKey,
        })
        .onConflictDoNothing({
          target: [budgetAlerts.companyId, budgetAlerts.projectId, budgetAlerts.deduplicationKey],
          where: sql`${budgetAlerts.status} <> 'resolved'`,
        })
        .returning();

      if (inserted) {
        created.push(inserted);
        await recordAuditEvent(tx, {
          companyId,
          actorUserId,
          action: "budgetAlert.created",
          entityType: "budget_alert",
          entityId: inserted.id,
          afterValue: inserted,
          metadata: { projectId, ruleCode: inserted.ruleCode, severity: inserted.severity },
        });
      }
    }
  });

  return created;
}

// Evaluates ONE project's alerts: collects inputs exclusively from the
// existing canonical sources (never from any request body), runs the
// deterministic rule engine, and persists any new alert instances.
async function evaluateProject(companyId: string, projectId: string, actorUserId: string) {
  const asOfDate = todayStr();
  const inputs = await collectForecastInputs(companyId, projectId, asOfDate);
  const forecast = calculateForecast("commitment_aware", inputs);

  const projectSnapshot = {
    budgetAmount: inputs.costPlan,
    actualAmount: inputs.actualCost,
    commitmentAmount: inputs.committedCost,
    forecastAmount: forecast.eac,
  };

  const candidates: PersistCandidate[] = [];

  const rule1 = evaluateBudgetConsumptionRule({ budget: inputs.costPlan, actual: inputs.actualCost, committed: inputs.committedCost });
  if (rule1) candidates.push({ hit: rule1, costCodeId: null, snapshot: projectSnapshot, currency: inputs.currency });

  const rule2 = evaluateForecastOverBudgetRule({ budget: inputs.costPlan, eac: forecast.eac, variancePercent: forecast.variancePercent });
  if (rule2) candidates.push({ hit: rule2, costCodeId: null, snapshot: projectSnapshot, currency: inputs.currency });

  const rule3 = evaluateActualCommitmentsOverBudgetRule({ budget: inputs.costPlan, actual: inputs.actualCost, committed: inputs.committedCost });
  if (rule3) candidates.push({ hit: rule3, costCodeId: null, snapshot: projectSnapshot, currency: inputs.currency });

  const costCodeInputs = await collectCostCodeInputs(companyId, projectId, asOfDate, inputs.currency);
  for (const [costCodeId, cc] of costCodeInputs) {
    const rule4 = evaluateCostCodeRiskRule(cc);
    if (rule4) {
      candidates.push({
        hit: rule4,
        costCodeId,
        snapshot: {
          budgetAmount: cc.costCodeBudget,
          actualAmount: cc.costCodeActual,
          commitmentAmount: cc.costCodeCommitted,
          forecastAmount: null,
        },
        currency: inputs.currency,
      });
    }
  }

  return persistCandidates(companyId, projectId, actorUserId, candidates);
}

const evaluateSchema = z.object({ projectId: z.string().uuid().optional() }).strict();

// Member-open (no requirePermission): evaluation only derives from
// financial data every company member can already read via the existing
// GET /budget, /commitments, /forecast routes (none of which are gated
// either) — it never mutates canonical financial truth, only persists an
// observation of it. This is deliberate: the dashboard/alerts list needs to
// trigger fresh evaluation on an ordinary member's page load, not only an
// owner's.
budgetAlertsRouter.post("/evaluate", async (req: Request, res: Response) => {
  const parsed = evaluateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  let targetProjectIds: string[];
  if (parsed.data.projectId) {
    // Never trust a frontend-supplied project id as-is: it must belong to
    // req.companyId (from the authenticated session), not any company the
    // caller merely claims.
    const project = await findOwnedProject(req.companyId!, parsed.data.projectId);
    if (!project) return res.status(404).json({ error: "المشروع غير موجود" });
    targetProjectIds = [project.id];
  } else {
    // Bounded by this company's own project count — no unbounded scan.
    // Completed projects are excluded: a finished project's budget state is
    // historical, not actionable, so evaluating it would only add noise.
    const rows = await db.query.projects.findMany({
      where: and(eq(projects.companyId, req.companyId!), ne(projects.status, "completed")),
      columns: { id: true },
    });
    targetProjectIds = rows.map((r) => r.id);
  }

  const createdByProject: Record<string, number> = {};
  for (const projectId of targetProjectIds) {
    const created = await evaluateProject(req.companyId!, projectId, req.userId!);
    createdByProject[projectId] = created.length;
  }

  res.json({ evaluatedProjectCount: targetProjectIds.length, createdCount: Object.values(createdByProject).reduce((a, b) => a + b, 0) });
});

const listQuerySchema = z
  .object({
    projectId: z.string().uuid().optional(),
    status: z.enum(["open", "acknowledged", "resolved"]).optional(),
    severity: z.enum(["info", "warning", "critical"]).optional(),
  })
  .strict();

budgetAlertsRouter.get("/", async (req: Request, res: Response) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  if (parsed.data.projectId) {
    const project = await findOwnedProject(req.companyId!, parsed.data.projectId);
    if (!project) return res.status(404).json({ error: "المشروع غير موجود" });
  }

  const conditions = [eq(budgetAlerts.companyId, req.companyId!)];
  if (parsed.data.projectId) conditions.push(eq(budgetAlerts.projectId, parsed.data.projectId));
  if (parsed.data.status) conditions.push(eq(budgetAlerts.status, parsed.data.status));
  if (parsed.data.severity) conditions.push(eq(budgetAlerts.severity, parsed.data.severity));

  const rows = await db.query.budgetAlerts.findMany({
    where: and(...conditions),
    orderBy: [desc(budgetAlerts.createdAt)],
    with: { project: { columns: { id: true, name: true } }, costCode: { columns: { id: true, code: true, name: true } } },
  });
  res.json(rows);
});

async function findOwnedAlert(companyId: string, id: string) {
  return db.query.budgetAlerts.findFirst({
    where: and(eq(budgetAlerts.id, id), eq(budgetAlerts.companyId, companyId)),
    with: { project: { columns: { id: true, name: true } }, costCode: { columns: { id: true, code: true, name: true } } },
  });
}

budgetAlertsRouter.get("/:id", async (req: Request<{ id: string }>, res: Response) => {
  const alert = await findOwnedAlert(req.companyId!, req.params.id);
  if (!alert) return res.status(404).json({ error: "التنبيه غير موجود" });
  res.json(alert);
});

// Dedicated transition actions only — no generic PATCH /:id exists in this
// router, so a client can never spoof severity/metrics/rule/project/
// company/financial values/detectedAt/acknowledgedBy/resolvedBy: none of
// those field names are ever read from req.body anywhere below.
budgetAlertsRouter.post(
  "/:id/acknowledge",
  requirePermission("budgetAlert.manage"),
  async (req: Request<{ id: string }>, res: Response) => {
    const alert = await findOwnedAlert(req.companyId!, req.params.id);
    if (!alert) return res.status(404).json({ error: "التنبيه غير موجود" });

    const result = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(budgetAlerts)
        .set({
          status: "acknowledged",
          acknowledgedAt: new Date(),
          acknowledgedByUserId: req.userId!,
          updatedAt: new Date(),
        })
        .where(and(eq(budgetAlerts.id, alert.id), eq(budgetAlerts.status, "open")))
        .returning();
      if (!updated) return null;

      await recordAuditEvent(tx, {
        companyId: req.companyId!,
        actorUserId: req.userId!,
        action: "budgetAlert.acknowledged",
        entityType: "budget_alert",
        entityId: alert.id,
        beforeValue: { status: "open" },
        afterValue: { status: "acknowledged" },
      });

      return updated;
    });

    if (!result) return res.status(409).json({ error: "لا يمكن تأكيد مشاهدة تنبيه ليس في حالة مفتوح" });
    res.json(result);
  },
);

budgetAlertsRouter.post(
  "/:id/resolve",
  requirePermission("budgetAlert.manage"),
  async (req: Request<{ id: string }>, res: Response) => {
    const alert = await findOwnedAlert(req.companyId!, req.params.id);
    if (!alert) return res.status(404).json({ error: "التنبيه غير موجود" });

    const result = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(budgetAlerts)
        .set({
          status: "resolved",
          resolvedAt: new Date(),
          resolvedByUserId: req.userId!,
          updatedAt: new Date(),
        })
        .where(and(eq(budgetAlerts.id, alert.id), sql`${budgetAlerts.status} IN ('open', 'acknowledged')`))
        .returning();
      if (!updated) return null;

      await recordAuditEvent(tx, {
        companyId: req.companyId!,
        actorUserId: req.userId!,
        action: "budgetAlert.resolved",
        entityType: "budget_alert",
        entityId: alert.id,
        beforeValue: { status: alert.status },
        afterValue: { status: "resolved" },
      });

      return updated;
    });

    if (!result) return res.status(409).json({ error: "لا يمكن حل تنبيه تم حله بالفعل" });
    res.json(result);
  },
);
