import { Router, type Request, type Response, type NextFunction } from "express";
import { and, eq, lte, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { invoiceItems, invoices, ipcs, projects } from "../db/schema.js";
import { computeTotals } from "../lib/money.js";
import { calculateForecast } from "../lib/forecast.js";
import { collectForecastInputs, todayStr } from "./forecast.js";
import { calculateCashFlow } from "../lib/cashflow.js";

type ProjectParams = { projectId: string };

export const cashflowRouter = Router({ mergeParams: true });

// Same tenant/ownership-scoping pattern as every other project sub-resource.
cashflowRouter.use(async (req: Request<ProjectParams>, res: Response, next: NextFunction) => {
  const project = await db.query.projects.findFirst({
    where: and(eq(projects.id, req.params.projectId), eq(projects.companyId, req.companyId!)),
  });
  if (!project) return res.status(404).json({ error: "المشروع غير موجود" });
  next();
});

// Sums an invoice status's total (item amounts + frozen tax rate, via the
// same lib/money.ts computeTotals every other invoice total computation in
// this codebase uses) for this project, cutoff-filtered on the economic
// date that actually represents that status: paidAt for paid invoices,
// issueDate for sent-but-unpaid ones. Never a generic "invoice amount" —
// an invoice has no single stored total column, and never a fabricated
// payment date for unpaid invoices.
async function sumInvoiceTotals(
  companyId: string,
  projectId: string,
  status: "paid" | "sent",
  cutoff: Date | string,
): Promise<number> {
  const dateCondition =
    status === "paid"
      ? and(sql`${invoices.paidAt} IS NOT NULL`, lte(invoices.paidAt, cutoff as Date))
      : lte(invoices.issueDate, cutoff as string);

  // Recovered — was a real N+1 (one invoiceItems query per invoice,
  // sequential, on every Cash Flow request). Same single-innerJoin
  // batching technique forecast.ts's collectForecastInputs already uses
  // for commitment lines: one query for every matching invoice's items,
  // grouped by invoiceId in JS, instead of one query per invoice.
  // taxRatePercent is still read per-invoice (frozen on the invoice
  // itself, never re-derived) so each invoice's own computeTotals call is
  // unchanged — only the item fetch is batched. Result is mathematically
  // identical: same computeTotals call per invoice, same final rounding.
  const rows = await db
    .select({
      invoiceId: invoiceItems.invoiceId,
      amount: invoiceItems.amount,
      taxRatePercent: invoices.taxRatePercent,
    })
    .from(invoiceItems)
    .innerJoin(invoices, eq(invoiceItems.invoiceId, invoices.id))
    .where(
      and(
        eq(invoices.projectId, projectId),
        eq(invoices.companyId, companyId),
        eq(invoices.status, status),
        dateCondition,
      ),
    );

  const amountsByInvoice = new Map<string, { amounts: number[]; taxRatePercent: number }>();
  for (const row of rows) {
    const entry = amountsByInvoice.get(row.invoiceId) ?? { amounts: [], taxRatePercent: Number(row.taxRatePercent) };
    entry.amounts.push(Number(row.amount));
    amountsByInvoice.set(row.invoiceId, entry);
  }

  let total = 0;
  for (const { amounts, taxRatePercent } of amountsByInvoice.values()) {
    const totals = computeTotals(amounts, taxRatePercent);
    total += totals.total;
  }
  return Math.round(total * 100) / 100;
}

// Certified IPCs' netCertified (expected collection, net of withheld
// retention) and retentionAmount (undated — no release mechanism exists),
// cutoff-filtered on certifiedAt, mirroring routes/forecast.ts's own
// certified-IPC query exactly except for which columns are selected —
// this is Cash-Flow-specific data (retention/net), not a re-derivation of
// any Forecast formula.
async function collectCertifiedIpcFigures(companyId: string, projectId: string, cutoff: Date) {
  const rows = await db
    .select({ netCertified: ipcs.netCertified, retentionAmount: ipcs.retentionAmount })
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
  const certifiedExpectedCollection = Math.round(rows.reduce((sum, r) => sum + Number(r.netCertified ?? 0), 0) * 100) / 100;
  const retentionToBeReleased = Math.round(rows.reduce((sum, r) => sum + Number(r.retentionAmount ?? 0), 0) * 100) / 100;
  return { certifiedExpectedCollection, retentionToBeReleased };
}

const advanceLimitation = {
  supported: false as const,
  reason: "Advance payment/recovery is not operationalized in the current financial model.",
};

// Computed, not persisted — projection-only, matching the owner-approved
// architecture: no cash-flow ledger, no payment transaction table, no
// snapshot numbering. asOfDate is the only cutoff supported; there is no
// from/to/granularity — the current data model has no time-phasing
// mechanism for Commitment/Expense/ETC, so a date-range curve would be
// fake precision (see docs/MIDAD_CASHFLOW_MODEL.md).
cashflowRouter.get("/", async (req: Request<ProjectParams>, res: Response) => {
  const asOfDateParam = typeof req.query.asOfDate === "string" ? req.query.asOfDate : undefined;
  if (asOfDateParam !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(asOfDateParam)) {
    return res.status(400).json({ error: "تنسيق التاريخ غير صحيح" });
  }
  const asOfDate = asOfDateParam ?? todayStr();
  if (asOfDate > todayStr()) {
    return res.status(400).json({ error: "لا يمكن أن يكون تاريخ التدفق النقدي في المستقبل" });
  }
  const cutoff = new Date(`${asOfDate}T23:59:59.999Z`);

  // Reused verbatim from Forecast — never independently re-derived here.
  const forecastInputs = await collectForecastInputs(req.companyId!, req.params.projectId, asOfDate);
  const forecastCalc = calculateForecast("commitment_aware", forecastInputs);

  const [cashReceived, receivables, ipcFigures] = await Promise.all([
    sumInvoiceTotals(req.companyId!, req.params.projectId, "paid", cutoff),
    sumInvoiceTotals(req.companyId!, req.params.projectId, "sent", asOfDate),
    collectCertifiedIpcFigures(req.companyId!, req.params.projectId, cutoff),
  ]);

  const result = calculateCashFlow({
    cashReceived,
    incurredCost: forecastInputs.actualCost,
    receivables,
    certifiedExpectedCollection: ipcFigures.certifiedExpectedCollection,
    commitments: forecastInputs.committedCost,
    etc: forecastCalc.etc,
    retentionToBeReleased: ipcFigures.retentionToBeReleased,
  });

  res.json({
    projectId: req.params.projectId,
    asOfDate,
    currency: forecastInputs.currency,
    excludedForeignCurrencyCommitmentIds: forecastInputs.excludedForeignCurrencyCommitmentIds,
    ...result,
    undated: { ...result.undated, advance: advanceLimitation },
    assumptions: {
      forecastMethod: "commitment_aware",
      certifiedValueBasis: "netCertified (gross certified value minus withheld retention)",
      commitmentExpenseReconciliation:
        "not modeled — no expenses.commitmentId relationship exists; a commitment already paid via a logged expense is not reconciled",
      ipcInvoiceReconciliation:
        "not modeled — no relationship exists between ipcs and invoices; a certified IPC's value is not automatically matched to any invoice",
    },
  });
});
