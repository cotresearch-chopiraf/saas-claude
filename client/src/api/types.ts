export interface User {
  id: string;
  name: string;
  email: string;
  // Presentation only — the backend independently re-checks this on every
  // mutation route. Never treat the presence/absence of a UI element as a
  // security boundary; see auth/permissions.ts.
  role: CompanyRole;
}

export interface Company {
  id: string;
  name: string;
}

export interface AppNotification {
  id: string;
  type: string;
  title: string;
  message: string;
  readAt: string | null;
  referenceEntityType: string | null;
  referenceEntityId: string | null;
  createdAt: string;
}

export type ProjectStatus = "active" | "on_hold" | "completed";

export interface Project {
  id: string;
  companyId: string;
  name: string;
  clientName: string | null;
  // MIDAD Phase A' — optional link to a first-class Customer, fully
  // independent of clientName (never derived from it, never required to
  // match it). null means no customer is linked.
  customerId: string | null;
  address: string | null;
  status: ProjectStatus;
  budgetTotal: string;
  startDate: string | null;
  createdAt: string;
}

export interface BudgetItem {
  id: string;
  projectId: string;
  category: string;
  plannedAmount: string;
  spent: number;
  createdAt: string;
  // Already returned by GET /projects/:id/budget (a plain findMany with no
  // column restriction) — previously untyped/unused client-side. See
  // docs/MIDAD_FINANCIAL_MODEL.md: these are the Phase 1 links that make a
  // budget item a real Cost Plan line rather than a free-text category.
  costCodeId: string | null;
  boqItemId: string | null;
  budgetRevisionId: string | null;
}

// --- MIDAD UI-01: Contract, BOQ, Cost Code, Budget Revision ---
// Every field below mirrors server/src/db/schema.ts and the corresponding
// route's actual response shape exactly (verified fresh during the UI-01
// discovery pass) — no speculative field is included.

export type ContractType = "main" | "amendment";
export type ContractStatus = "draft" | "active" | "completed" | "terminated";

export interface Contract {
  id: string;
  companyId: string;
  projectId: string;
  contractType: ContractType;
  parentContractId: string | null;
  contractNumber: string | null;
  clientName: string | null;
  originalValue: string;
  revisedValue: string;
  currency: string;
  advancePercent: string | null;
  retentionPercent: string | null;
  paymentTerms: string | null;
  status: ContractStatus;
  startDate: string | null;
  endDate: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export type BoqRevisionStatus = "draft" | "published" | "superseded";
export type BoqItemType = "section" | "item";

export interface BoqRevision {
  id: string;
  companyId: string;
  projectId: string;
  contractId: string;
  revisionNumber: number;
  status: BoqRevisionStatus;
  supersedesRevisionId: string | null;
  notes: string | null;
  createdBy: string;
  createdAt: string;
  publishedAt: string | null;
}

export interface BoqItem {
  id: string;
  boqRevisionId: string;
  parentItemId: string | null;
  itemType: BoqItemType;
  code: string | null;
  description: string;
  unit: string | null;
  quantity: string | null;
  rate: string | null;
  // Frozen server-side at write time (quantity * rate) — never recompute
  // this in the frontend; always display exactly what the API returns.
  amount: string | null;
  costCodeId: string | null;
  sortOrder: number;
  createdAt: string;
}

export interface BoqRevisionWithItems extends BoqRevision {
  items: BoqItem[];
}

export type CostCodeCategory =
  | "labor"
  | "materials"
  | "equipment"
  | "subcontract"
  | "site_overhead"
  | "general_overhead"
  | "other";

export interface CostCode {
  id: string;
  companyId: string;
  projectId: string | null;
  code: string;
  name: string;
  category: CostCodeCategory | null;
  parentCostCodeId: string | null;
  createdAt: string;
}

export type BudgetRevisionStatus = "draft" | "approved" | "superseded";

export interface BudgetRevision {
  id: string;
  companyId: string;
  projectId: string;
  revisionNumber: number;
  status: BudgetRevisionStatus;
  reason: string | null;
  createdBy: string;
  createdAt: string;
  approvedBy: string | null;
  approvedAt: string | null;
}

export interface BudgetRevisionWithItems extends BudgetRevision {
  items: BudgetItem[];
}

// --- MIDAD UI-02: Supplier ---
// Mirrors server/src/db/schema.ts's `suppliers` table and
// server/src/routes/suppliers.ts's response shape exactly (verified fresh
// during the UI-02 discovery pass). No delete endpoint exists — "removal"
// is only ever a status change to "inactive".
export type SupplierType = "supplier" | "subcontractor";
export type SupplierStatus = "active" | "inactive";

export interface Supplier {
  id: string;
  companyId: string;
  name: string;
  type: SupplierType;
  taxId: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  status: SupplierStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

// MIDAD Phase A' — mirrors server/src/routes/customers.ts exactly. Same
// shape class/discipline as Supplier above (company-wide master data, no
// delete endpoint — "removal" is only ever a status change to
// "inactive"). Deliberately unrelated to Supplier (a different direction:
// who we bill, not who bills us).
export type CustomerStatus = "active" | "inactive";

export interface Customer {
  id: string;
  companyId: string;
  name: string;
  contactName: string | null;
  taxId: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  notes: string | null;
  status: CustomerStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

// GET /customers/:id's response — the customer plus its linked projects
// (read-only, id/name/status only), never a second source of truth for a
// project's own fields.
export interface CustomerWithProjects extends Customer {
  projects: Array<{ id: string; name: string; status: ProjectStatus }>;
}

// --- MIDAD Phase A2: Employee ---
// Mirrors server/src/db/schema.ts's `employees` table and
// server/src/routes/employees.ts's response shape exactly. Same shape
// class as Supplier/Customer above (company-wide master data, no delete
// endpoint — "removal" is only ever a status change to "inactive").
// nationality/bankName/iban exist on the backend row (added in A1, for a
// future Mudad/WPS-facing slice) but are deliberately NOT modeled here —
// this slice's UI never reads or writes them.
export type EmployeeStatus = "active" | "inactive";

export interface Employee {
  id: string;
  companyId: string;
  employeeNumber: string;
  name: string;
  jobTitle: string | null;
  hireDate: string | null;
  status: EmployeeStatus;
  email: string | null;
  phone: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

// --- MIDAD Phase A3: Payroll Period + Payroll Record ---
// Mirrors server/src/db/schema.ts's `payroll_periods`/`payroll_records`
// tables (added in A1) and server/src/routes/payrollPeriods.ts /
// payrollRecords.ts's response shapes exactly. "posted" is reached only
// through POST /payroll-periods/:id/post (Phase A5, requires
// `payroll.post`) — the one point a period becomes financial truth.
export type PayrollPeriodStatus = "draft" | "submitted" | "approved" | "posted" | "rejected";

export interface PayrollSummary {
  employeeCount: number;
  totalGross: number;
  totalDeductions: number;
  totalNet: number;
}

export interface PayrollPeriod {
  id: string;
  companyId: string;
  periodStart: string;
  periodEnd: string;
  payrollDate: string | null;
  status: PayrollPeriodStatus;
  notes: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  submittedBy: string | null;
  submittedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  postedBy: string | null;
  postedAt: string | null;
  rejectedBy: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  summary: PayrollSummary;
}

// GET /payroll-periods/:id's response — the period plus its records
// (read-only embed, same "embed related read-only data" precedent as
// CustomerWithProjects above).
export interface PayrollPeriodWithRecords extends PayrollPeriod {
  records: PayrollRecord[];
}

export type PayrollRecordSourceType = "manual" | "csv_import" | "excel_import" | "external_provider";
export type PayrollVerificationStatus = "unverified" | "verified";

export interface PayrollRecordEmployee {
  id: string;
  name: string;
  employeeNumber: string;
  status: EmployeeStatus;
}

export interface PayrollRecord {
  id: string;
  companyId: string;
  payrollPeriodId: string;
  employeeId: string;
  grossAmount: string;
  deductionsAmount: string;
  netAmount: string;
  sourceType: PayrollRecordSourceType;
  provider: string | null;
  externalReference: string | null;
  verificationStatus: PayrollVerificationStatus;
  importBatchId: string | null;
  importedAt: string | null;
  verifiedAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  employee: PayrollRecordEmployee;
}

// --- MIDAD Phase A4: Labor Allocation ---
// Mirrors server/src/db/schema.ts's `labor_allocations` table (added in
// A1) and server/src/routes/laborAllocations.ts's response shape exactly.
// amount is server-computed and frozen (netAmount * percentage / 100 at
// save time) — never recomputed client-side. No status field exists (like
// PayrollRecord, its editability is governed entirely by the parent
// payroll period's status).
export interface LaborAllocationProject {
  id: string;
  name: string;
}

export interface LaborAllocationCostCode {
  id: string;
  code: string;
  name: string;
}

export interface LaborAllocation {
  id: string;
  companyId: string;
  payrollRecordId: string;
  projectId: string;
  costCodeId: string | null;
  percentage: string;
  amount: string;
  notes: string | null;
  createdBy: string;
  createdAt: string;
  project: LaborAllocationProject;
  costCode: LaborAllocationCostCode | null;
}

// GET /projects/:id/labor-cost's response — read-only visibility into
// this project's Labor Allocation total AND how much of it has actually
// been posted (see routes/laborCost.ts's own comment on why a reversed
// posting reads back as unposted). Never a second Actual Cost source: the
// real financial contribution of a posted allocation lives in the
// project's own Expenses/Actual Cost, driven by the Expense A5's posting
// route created — this endpoint only answers "how much of what's
// allocated here has been posted so far."
export interface ProjectLaborCost {
  projectId: string;
  allocatedTotal: number;
  allocationCount: number;
  postedTotal: number;
  unpostedTotal: number;
  // true only when there is at least one allocation AND none of it remains
  // unposted (unpostedTotal === 0) — i.e. fully posted, not merely "some".
  posted: boolean;
}

// --- MIDAD Phase A5: Labor Cost Posting ---
// Mirrors server/src/db/schema.ts's `labor_cost_postings` table and
// server/src/routes/laborCostPostings.ts's response shape exactly.
// `kind: "posting"` rows are the actual financial mutation (one per
// posted Labor Allocation, each linked to the real `expenses` row it
// created); `kind: "reversal"` rows are the only way that gets undone —
// always additive, never a delete/edit of the original.
export type LaborCostPostingKind = "posting" | "reversal";

export interface LaborCostPostingExpense {
  id: string;
  amount: string;
  expenseDate: string;
  description: string;
}

export interface LaborCostPosting {
  id: string;
  companyId: string;
  payrollPeriodId: string;
  laborAllocationId: string;
  expenseId: string;
  kind: LaborCostPostingKind;
  reversalOfPostingId: string | null;
  postedBy: string;
  postedAt: string;
  expense?: LaborCostPostingExpense;
  laborAllocation?: LaborAllocation;
}

// POST /payroll-periods/:id/post's response.
export interface PayrollPeriodPostResult {
  period: PayrollPeriod;
  postings: LaborCostPosting[];
  totalPosted: number;
}

// --- MIDAD UI-03A: Commitment (Purchase Order / Subcontract) ---
// Mirrors server/src/db/schema.ts's `commitments`/`commitment_lines` tables
// and server/src/routes/commitments.ts's response shapes exactly (verified
// fresh during the UI-03A implementation pass). originalAmount/revisedAmount
// are backend-derived (frozen from SUM(lines) at submit/amend time) —
// never independently editable or recomputed client-side.
export type CommitmentType = "purchase_order" | "subcontract";
export type CommitmentStatus =
  | "draft"
  | "pending_approval"
  | "active"
  | "partially_fulfilled"
  | "closed"
  | "cancelled";

export interface Commitment {
  id: string;
  companyId: string;
  projectId: string;
  contractId: string | null;
  supplierId: string;
  type: CommitmentType;
  status: CommitmentStatus;
  commitmentNumber: number;
  description: string | null;
  originalAmount: string | null;
  revisedAmount: string | null;
  // MIDAD Phase 2 — Subcontractor IPC foundation. Nullable: most existing
  // commitments predate this field. The authoritative retention rate for
  // THIS commitment — never contracts.retentionPercent, a different
  // financial direction entirely.
  retentionPercent: string | null;
  currency: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  cancelledAt: string | null;
}

export interface CommitmentLine {
  id: string;
  companyId: string;
  commitmentId: string;
  costCodeId: string | null;
  boqItemId: string | null;
  description: string;
  quantity: string | null;
  rate: string | null;
  // Frozen server-side at write time (quantity * rate, or an explicit
  // amount) — never recompute this in the frontend; always display exactly
  // what the API returns. Same discipline as boqItems.amount.
  amount: string;
  sortOrder: number;
  createdAt: string;
}

export interface CommitmentWithLines extends Commitment {
  lines: CommitmentLine[];
}

export interface Expense {
  id: string;
  projectId: string;
  budgetItemId: string | null;
  description: string;
  amount: string;
  expenseDate: string;
  createdAt: string;
}

export interface BudgetSummary {
  items: BudgetItem[];
  expenses: Expense[];
  totals: { planned: number; spent: number; remaining: number };
}

// --- MIDAD UI-04: Measurement (physical progress) ---
// Mirrors server/src/db/schema.ts's `measurements`/`measurement_lines`
// tables and server/src/routes/measurements.ts's response shapes exactly
// (verified fresh during the UI-04 discovery pass). Non-financial: `value`
// is a frozen (measuredQuantity * boqItem.rate) figure for future IPC's
// convenience, never a certification/valuation amount, and never
// recomputed client-side. Cumulative approved quantity is never stored on
// this type — it is only ever surfaced via an approve-attempt's 409 body.
export type MeasurementStatus = "draft" | "submitted" | "approved" | "rejected";

export interface Measurement {
  id: string;
  companyId: string;
  projectId: string;
  contractId: string;
  boqRevisionId: string;
  status: MeasurementStatus;
  measurementDate: string;
  description: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  submittedBy: string | null;
  submittedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  rejectedBy: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
}

export interface MeasurementLine {
  id: string;
  companyId: string;
  measurementId: string;
  boqItemId: string;
  measuredQuantity: string;
  // Frozen server-side at write time (measuredQuantity * boqItem.rate) —
  // never recompute this in the frontend; always display exactly what the
  // API returns. Same discipline as boqItems.amount.
  value: string | null;
  notes: string | null;
  createdAt: string;
}

export interface MeasurementWithLines extends Measurement {
  lines: MeasurementLine[];
}

// --- MIDAD UI-05: Forecast (ETC/EAC) ---
// Mirrors server/src/routes/forecast.ts's actual response shapes exactly
// (verified fresh during the UI-05 discovery pass). Two distinct shapes,
// deliberately not unified: the live GET /forecast response computes
// costPlan/actualCost/etc/eac/... as plain JS numbers (lib/forecast.ts's
// calculateForecast never touches the database), while a persisted
// forecast_snapshots row returns the same figures as strings, like every
// other DB-backed numeric column in this app. Every figure here is frozen
// or computed server-side — never recomputed client-side (see
// docs/MIDAD_FORECAST_MODEL.md and lib/format.ts's header comment).
export type ForecastMethod = "cost_to_complete" | "commitment_aware";

export interface ForecastCalculation {
  method: ForecastMethod;
  costPlan: number;
  actualCost: number;
  committedCost: number;
  // Contextual only — certified IPC value, never blended into etc/eac.
  certifiedValue: number;
  remainingCost: number;
  etc: number;
  eac: number;
  variance: number;
  // null (never 0) when costPlan is 0 — a percentage of zero is undefined.
  variancePercent: number | null;
}

export interface ForecastResult {
  projectId: string;
  asOfDate: string;
  currency: string;
  // Commitment ids excluded from committedCost because their currency
  // didn't match the project's determined currency — never silently
  // summed across currencies, never silently dropped without a trail.
  excludedForeignCurrencyCommitmentIds: string[];
  methods: Record<ForecastMethod, ForecastCalculation>;
}

export interface ForecastSnapshotAssumptions {
  excludedForeignCurrencyCommitmentIds: string[];
}

export interface ForecastSnapshot {
  id: string;
  companyId: string;
  projectId: string;
  asOfDate: string;
  method: ForecastMethod;
  currency: string;
  costPlan: string;
  actualCost: string;
  committedCost: string;
  certifiedValue: string;
  remainingCost: string;
  etc: string;
  eac: string;
  variance: string;
  variancePercent: string | null;
  assumptions: ForecastSnapshotAssumptions;
  notes: string | null;
  createdBy: string;
  createdAt: string;
}

// --- MIDAD UI-06: Cash Flow ---
// Mirrors server/src/routes/cashflow.ts's / server/src/lib/cashflow.ts's
// actual response shape exactly (verified fresh during the UI-06
// discovery pass). Projection-only, never persisted — every figure is a
// plain JS number, exactly like Forecast's own live GET response (there
// is no Cash Flow snapshot entity, so no DB-numeric-string variant
// exists here). `undated.etc` and `projected.commitments` are Forecast's
// own commitment-aware ETC / committedCost, reused verbatim server-side —
// never re-derived here. EAC is deliberately never part of this shape
// (see docs/MIDAD_CASHFLOW_MODEL.md — including it would invite
// double-counting against AC + Commitment + ETC).
export interface CashFlowResult {
  projectId: string;
  asOfDate: string;
  currency: string;
  // Commitment ids excluded from projected.commitments because their
  // currency didn't match the project's determined currency — never
  // silently summed across currencies, never silently dropped.
  excludedForeignCurrencyCommitmentIds: string[];
  historical: {
    // Σ paid invoices' totals, paidAt <= asOfDate — real payment evidence only.
    cashReceived: number;
    // Σ expenses, expenseDate <= asOfDate — reused from Forecast's own AC.
    incurredCost: number;
  };
  projected: {
    // Σ issued-but-unpaid ("sent") invoices' totals.
    receivables: number;
    // Σ certified IPCs' netCertified (gross minus withheld retention).
    certifiedExpectedCollection: number;
    // = Forecast's own committedCost, reused verbatim.
    commitments: number;
    // (receivables + certifiedExpectedCollection) - commitments — never
    // blends in historical or undated amounts.
    net: number;
  };
  undated: {
    // = Forecast's own commitment-aware ETC, reused verbatim.
    etc: number;
    // Σ certified IPCs' retentionAmount — no release date exists anywhere.
    retentionToBeReleased: number;
    advance: { supported: false; reason: string };
  };
  assumptions: {
    forecastMethod: string;
    certifiedValueBasis: string;
    commitmentExpenseReconciliation: string;
    ipcInvoiceReconciliation: string;
  };
}

// --- MIDAD UI-07: IPC (Interim Payment Certificate) ---
// Mirrors server/src/db/schema.ts's `ipcs`/`ipc_lines` tables and
// server/src/routes/ipcs.ts's actual response shapes exactly (verified
// fresh during the UI-07 discovery/implementation pass). A certified
// financial document: grossValue/retentionAmount/advanceRecoveryAmount/
// otherDeductions/netCertified are all null until certify() freezes them
// server-side — never computed or recomputed client-side. Likewise a
// line's previousCertifiedQuantity/previousCertifiedValue/
// cumulativeQuantity are null until that same certify() call freezes the
// certification-time ledger snapshot.
export type IpcStatus = "draft" | "submitted" | "approved" | "certified" | "rejected";

export interface Ipc {
  id: string;
  companyId: string;
  projectId: string;
  contractId: string;
  boqRevisionId: string;
  ipcNumber: number;
  status: IpcStatus;
  periodStart: string;
  periodEnd: string;
  notes: string | null;
  grossValue: string | null;
  retentionAmount: string | null;
  advanceRecoveryAmount: string | null;
  otherDeductions: string | null;
  netCertified: string | null;
  currency: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  submittedBy: string | null;
  submittedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  certifiedBy: string | null;
  certifiedAt: string | null;
  rejectedBy: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
}

export interface IpcLine {
  id: string;
  companyId: string;
  ipcId: string;
  boqItemId: string;
  description: string | null;
  currentQuantity: string;
  rate: string;
  currentValue: string;
  previousCertifiedQuantity: string | null;
  previousCertifiedValue: string | null;
  cumulativeQuantity: string | null;
  sortOrder: number;
  createdAt: string;
}

export interface IpcWithLines extends Ipc {
  lines: IpcLine[];
}

// POST /ipcs's own response is deliberately narrower than `Ipc` — it's
// built from a raw SQL INSERT...RETURNING (for the same-transaction
// contract-row-locked MAX+1 numbering), not Drizzle's ORM layer, so it
// returns exactly these four snake_case columns rather than the full
// camelCase row every other IPC route returns. The section only ever
// needs `id` from this to select the new IPC and reload its full detail.
export interface IpcCreateResult {
  id: string;
  ipc_number: number;
  status: IpcStatus;
  created_at: string;
}

// MIDAD Phase 2 — Subcontractor IPC. A completely separate certification
// ledger from Owner IPC (Ipc/IpcLine above) — see
// server/src/routes/subcontractIpcs.ts. Certified against a
// commitments/commitmentLines row (type="subcontract"), never against a
// BOQ item directly.
export type SubcontractIpcStatus = "draft" | "submitted" | "approved" | "certified" | "rejected";

export interface SubcontractIpc {
  id: string;
  companyId: string;
  projectId: string;
  commitmentId: string;
  ipcNumber: number;
  status: SubcontractIpcStatus;
  periodStart: string;
  periodEnd: string;
  notes: string | null;
  grossValue: string | null;
  // The retention PERCENTAGE actually used, frozen at certify() — read
  // live from commitments.retentionPercent, never contracts.retentionPercent.
  retentionPercent: string | null;
  retentionAmount: string | null;
  advanceRecoveryAmount: string | null;
  otherDeductions: string | null;
  netCertified: string | null;
  currency: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  submittedBy: string | null;
  submittedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  certifiedBy: string | null;
  certifiedAt: string | null;
  rejectedBy: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
}

export interface SubcontractIpcLine {
  id: string;
  companyId: string;
  subcontractIpcId: string;
  commitmentLineId: string;
  description: string | null;
  // Quantity/rate path fields — null for an amount-only commitment line.
  currentQuantity: string | null;
  rate: string | null;
  // Always set on both paths: quantity*rate (server-computed) or the
  // directly entered certification amount.
  currentValue: string;
  previousCertifiedQuantity: string | null;
  cumulativeQuantity: string | null;
  previousCertifiedValue: string | null;
  cumulativeValue: string | null;
  sortOrder: number;
  createdAt: string;
}

export interface SubcontractIpcWithLines extends SubcontractIpc {
  lines: SubcontractIpcLine[];
}

// POST /subcontract-ipcs's own response is a raw SQL INSERT...RETURNING
// (same commitment-row-locked MAX+1 numbering discipline as ipcs.ts's own
// IpcCreateResult) — deliberately narrower than SubcontractIpc.
export interface SubcontractIpcCreateResult {
  id: string;
  ipc_number: number;
  status: SubcontractIpcStatus;
  created_at: string;
}

export type TaskStatus = "todo" | "in_progress" | "done";

export interface Task {
  id: string;
  projectId: string;
  title: string;
  assigneeName: string | null;
  dueDate: string | null;
  status: TaskStatus;
  createdAt: string;
}

export type ChangeOrderStatus = "pending" | "approved" | "rejected";

export interface ChangeOrder {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  amountDelta: string;
  status: ChangeOrderStatus;
  createdAt: string;
}

export interface DailyLog {
  id: string;
  projectId: string;
  note: string;
  logDate: string;
  createdAt: string;
}

export type QuoteStatus = "draft" | "sent" | "accepted" | "rejected";
export type DocumentLanguage = "ar" | "fr" | "en";

export interface Quote {
  id: string;
  companyId: string;
  quoteNumber: string | null;
  clientName: string;
  clientEmail: string | null;
  projectName: string;
  language: DocumentLanguage;
  status: QuoteStatus;
  publicToken: string;
  acceptedByName: string | null;
  acceptedAt: string | null;
  createdAt: string;
  subtotal: number;
}

export interface QuoteItem {
  id: string;
  quoteId: string;
  description: string;
  amount: string;
}

export interface PublicQuote {
  projectName: string;
  clientName: string;
  status: QuoteStatus;
  companyName: string;
  items: QuoteItem[];
  total: number;
}

export type CompanyRole = "owner" | "member";
export type CompanyMemberStatus = "active" | "deactivated";

export interface CompanyMember {
  id: string;
  name: string;
  email: string;
  role: CompanyRole;
  status: CompanyMemberStatus;
  createdAt: string;
}

export interface CompanyInvite {
  id: string;
  email: string;
  role: CompanyRole;
  expiresAt: string;
  createdAt: string;
}

export interface CompanyFeatureFlags {
  invoicing: boolean;
}

export interface CompanySettings {
  name: string;
  logoPath: string | null;
  address: string | null;
  taxId: string | null;
  phone: string | null;
  defaultTaxRatePercent: string;
  featureFlags: CompanyFeatureFlags;
}

export type InvoiceStatus = "draft" | "sent" | "paid";

export interface Invoice {
  id: string;
  companyId: string;
  quoteId: string | null;
  // Additive Phase 2E fields (nullable — most historical invoices predate
  // project/contract allocation and remain valid, unallocated invoices).
  projectId: string | null;
  contractId: string | null;
  invoiceNumber: string;
  clientName: string;
  clientAddress: string | null;
  clientTaxId: string | null;
  taxRatePercent: string;
  language: DocumentLanguage;
  status: InvoiceStatus;
  publicToken: string;
  issueDate: string;
  dueDate: string | null;
  paidAt: string | null;
  createdAt: string;
  subtotal: number;
  taxAmount: number;
  total: number;
}

// MIDAD UI-10 — mirrors server/src/routes/documents.ts's toDocumentResponse
// exactly. No status/category/approval/version-workflow fields exist on
// this response — the backend doesn't support them, so none are declared
// here either.
export interface ProjectDocument {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  uploadedAt: string;
  uploadedByName: string | null;
  version: number;
  previousVersionId: string | null;
}

// MIDAD Phase 3 — mirrors server/src/routes/subcontractIpcDocuments.ts's
// toDocumentResponse exactly. Same shape as ProjectDocument (a separate
// interface, not a reuse, since the two are independent entity types on
// the backend).
export interface SubcontractIpcDocument {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  uploadedAt: string;
  uploadedByName: string | null;
  version: number;
  previousVersionId: string | null;
}

// MIDAD Phase 4 — Compliance / Tax Center. Mirrors
// server/src/lib/compliance/types.ts and server/src/routes/compliance.ts
// exactly, read fresh from the live backend (not inferred) — the frontend
// never invents a field the backend doesn't actually return. This domain
// is company-scoped (no projectId anywhere), matching Settings/Team/
// Suppliers, not the project-scoped domains above.
export type CountryCode = "SA" | "AE" | "QA" | "KW" | "BH" | "OM" | "MA";

export interface ComplianceCountry {
  countryCode: CountryCode;
  // Partial: a country pack is not required to supply every language.
  displayName: Partial<Record<DocumentLanguage, string>>;
}

export type ComplianceProfileStatus = "configured" | "partially_configured" | "review_required";

export interface ComplianceProfile {
  id: string;
  companyId: string;
  countryCode: CountryCode;
  legalEntityType: string | null;
  businessActivity: string | null;
  taxRegistrationStatus: string | null;
  activeRuleVersionId: string;
  status: ComplianceProfileStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ComplianceTaxCategoryDefinition {
  code: string;
  label: Partial<Record<DocumentLanguage, string>>;
  ratePercent: number | null;
}

export interface ComplianceWithholdingRule {
  vendorType: string;
  serviceCategory: string | null;
  ratePercent: number;
}

export interface ComplianceRequiredIdentifier {
  type: string;
  label: Partial<Record<DocumentLanguage, string>>;
  required: boolean;
}

// The full ComplianceRules payload (server/src/lib/compliance/types.ts) —
// displayed as-is, never recomputed. No tax percentage on this page is
// ever calculated from anything other than a value already present here
// or on a ComplianceOverride below.
export interface ComplianceRules {
  vat: { applicable: boolean; standardRatePercent: number; categories: ComplianceTaxCategoryDefinition[] };
  withholding: { applicable: boolean; rules: ComplianceWithholdingRule[] };
  zakat: { applicable: boolean; reviewRequired: boolean; notes?: string };
  eInvoicing: { required: boolean; profile: string | null; notes?: string };
  invoice: { requiredFields: string[]; bilingualRequired: boolean };
  localization: { currency: string; language: DocumentLanguage; direction: "rtl" | "ltr"; dateFormat: string };
  identifiers: ComplianceRequiredIdentifier[];
}

export type ComplianceRulesResponse =
  | { status: "review_required"; reason: string }
  | { status: "resolved"; countryCode: CountryCode; ruleVersion: string; ruleVersionId: string; rules: ComplianceRules };

export type ComplianceZakatStatus =
  | { status: "resolved"; applicable: boolean; reviewRequired: boolean; notes?: string }
  | { status: "review_required"; reason: string };

export type ComplianceStatus =
  | { status: "not_configured" }
  | {
      status: ComplianceProfileStatus;
      countryCode: CountryCode;
      ruleVersion: string | null;
      zakat: ComplianceZakatStatus;
      overrideCount: number;
      lastUpdate: string;
    };

export type ComplianceOverrideStatus = "active" | "reset";

// overrideValue/officialDefaultSnapshot are JSONB on the backend (a
// setting's value may be a number or a boolean today) — kept as `unknown`
// here rather than assumed to always be a percentage, since a future
// overridable setting key is not something this page predicts.
export interface ComplianceOverride {
  id: string;
  companyId: string;
  settingKey: string;
  overrideValue: unknown;
  officialDefaultSnapshot: unknown;
  ruleVersionId: string;
  status: ComplianceOverrideStatus;
  effectiveFrom: string;
  effectiveTo: string | null;
  reason: string | null;
  createdBy: string;
  createdAt: string;
  resetAt: string | null;
  resetBy: string | null;
}

// The exact two-step contract server/src/routes/compliance.ts's POST
// /overrides implements — the frontend must branch on `status` and never
// flatten this into a single-step save.
export type CreateOverrideResult =
  | { status: "confirmation_required"; warning: string; officialDefault: unknown }
  | { status: "created"; override: ComplianceOverride };

// MIDAD Phase C — the shape returned by GET /api/audit-events (the general
// company-wide Activity Timeline). Deliberately a different shape than
// ComplianceAuditEvent below: this one adds the resolved actor name/email
// (never fabricated — null when the underlying event has no actor) and is
// always paginated. Same canonical audit_events table, a different read
// surface over it.
export interface ActivityEvent {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  actorUserId: string | null;
  actorName: string | null;
  actorEmail: string | null;
  reason: string | null;
  source: string;
  beforeValue: unknown;
  afterValue: unknown;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface ActivityPage {
  events: ActivityEvent[];
  limit: number;
  offset: number;
  hasMore: boolean;
}

// Slice AA Scope G — same limit/offset/hasMore shape as ActivityPage, one
// per paginated list endpoint.
export interface QuotesPage {
  quotes: Quote[];
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface InvoicesPage {
  invoices: Invoice[];
  limit: number;
  offset: number;
  hasMore: boolean;
}

// The canonical audit_events shape (server/src/db/schema.ts), as returned
// by GET /compliance/history — never a compliance-specific shape.
export interface ComplianceAuditEvent {
  id: string;
  companyId: string;
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  beforeValue: unknown;
  afterValue: unknown;
  reason: string | null;
  source: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

// MIDAD ZATCA e-invoicing (Slice 3) — server/src/routes/zatca.ts. Every
// field here is exactly what the backend returns; this page never derives
// or fabricates a status the server didn't send. Note there is
// deliberately no "zatcaConnected: boolean" anywhere — status/csidStatus
// are the real, multi-value state, never collapsed to a boolean.
export interface ZatcaTenantIdentity {
  legalName: string | null;
  address: string | null;
  vatNumber: string | null;
  commercialRegistration: string | null;
}

export type ZatcaEnvironment = "simulation" | "production";
export type ZatcaEgsStatus = "not_onboarded" | "onboarding" | "active" | "revoked" | "deactivated";
export type ZatcaCsidStatus = "none" | "compliance_pending" | "compliance_issued" | "production_issued" | "expired" | "revoked";

export interface ZatcaEgsUnit {
  id: string;
  name: string;
  environment: ZatcaEnvironment;
  status: ZatcaEgsStatus;
  csidStatus: ZatcaCsidStatus;
  certificateExpiresAt: string | null;
  lastCommunicationAt: string | null;
  hasCredential: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ZatcaConfig {
  identity: ZatcaTenantIdentity;
  egsUnits: ZatcaEgsUnit[];
}

export interface ZatcaVerifyConnectionResult {
  connected: boolean;
  reason: "not_connected" | "credential_rejected" | "connected";
  detail?: string;
  correlationId?: string;
  checkedAt?: string;
  egsUnit: ZatcaEgsUnit;
}

export interface ZatcaSubmission {
  id: string;
  companyId: string;
  egsUnitId: string;
  invoiceId: string | null;
  documentTypeCode: string;
  subtype: string;
  icv: number;
  documentHash: string;
  environment: ZatcaEnvironment;
  state: string;
  zatcaStatus: string | null;
  zatcaErrorCode: string | null;
  zatcaErrorMessage: string | null;
  retryCount: number;
  createdAt: string;
  respondedAt: string | null;
}

// AC-08 — company-wide submission history is now paginated. Mirrors
// InvoicesPage's shape exactly.
export interface ZatcaSubmissionsPage {
  submissions: ZatcaSubmission[];
  limit: number;
  offset: number;
  hasMore: boolean;
}

// MIDAD ZATCA onboarding (Slice 4) — server/src/lib/zatca/domain/onboarding.ts's
// computed view, never a second status system. See that file's own
// comment: status/csidStatus on each EGS unit remain the real, granular
// source of truth; this is one derived summary of them.
export type ZatcaOnboardingStatus =
  | "not_configured"
  | "configuration_incomplete"
  | "ready_for_simulation"
  | "simulation_connected"
  | "simulation_failed"
  | "production_not_enabled";

export interface ZatcaOnboardingStatusSummary {
  status: ZatcaOnboardingStatus;
  identityComplete: boolean;
  hasSimulationEgsUnit: boolean;
  hasProductionEgsUnit: boolean;
  simulationConnected: boolean;
  productionConnected: boolean;
}

export interface ZatcaValidationIssue {
  code: string;
  message: string;
}

export interface ZatcaValidationResult {
  valid: boolean;
  errors: ZatcaValidationIssue[];
  warnings: ZatcaValidationIssue[];
  sdkVerified: boolean;
}

export interface ZatcaPrepareResult {
  submission: ZatcaSubmission;
  validation: ZatcaValidationResult;
  alreadyExists: boolean;
}

export interface ZatcaSubmitResult {
  submission: ZatcaSubmission;
  alreadyAttempted?: boolean;
  error?: string;
  category?: string;
}

// ZATCA Customer Onboarding & Compliance Center — wraps
// server/src/routes/zatca.ts's CSR/CSID/Compliance CSID/Compliance
// Invoice/Production CSID/Renewal routes. Same rule as every other type in
// this file: every field is exactly what the backend returns, nothing
// derived or invented client-side. Private key material, binarySecurityToken,
// secret, and OTP are NEVER part of any of these types — the backend never
// returns them (see routes/zatca.ts's own comments on each route).

export interface ZatcaCsrFields {
  commonName: string;
  egsSerialNumber: string;
  organizationIdentifier: string;
  organizationUnitName: string;
  organizationName: string;
  countryCode: string;
  // TSXY structure — see server/src/lib/zatca/csr/csrBuilder.ts.
  invoiceType: string;
  location: string;
  industry: string;
}

// ZATCA-custom CSR attribute OIDs — see csrBuilder.ts's file comment: these
// are NOT public PKIX standard attributes and their OIDs are not invented
// anywhere in this codebase. Left empty by a tenant who doesn't have them;
// the backend then honestly refuses (400/configuration) rather than
// guessing, and this page must show that refusal, never route around it.
export interface ZatcaCsrCustomAttributeOids {
  egsSerialNumber?: string;
  invoiceType?: string;
  location?: string;
  industry?: string;
}

export interface ZatcaCsrGenerationResult {
  csrPem: string;
  csrDerBase64: string;
}

export type ZatcaCsrInstanceStatus = "generated" | "superseded";

export interface ZatcaCsrInstance {
  id: string;
  invoiceType: string;
  status: ZatcaCsrInstanceStatus;
  generatedAt: string;
}

export type ZatcaCsidConfirmResult = ZatcaEgsUnit;

export interface ZatcaComplianceCsidRequestResult {
  requestId: string;
  dispositionMessage: string;
}

export type ZatcaComplianceLifecycleStatus = "issued";

export interface ZatcaComplianceLifecycle {
  id: string;
  requestId: string;
  dispositionMessage: string;
  status: ZatcaComplianceLifecycleStatus;
  startedAt: string;
}

export type ZatcaInvoiceFamily = "standard" | "simplified";
export type ZatcaComplianceDocumentType = "388" | "381" | "383";

export interface ZatcaComplianceInvoiceResult {
  status: string;
  correlationId: string;
  rawStatus: string | null;
  warnings: unknown;
  clearanceStatus: string | null;
  qrSellertStatus: string | null;
  qrBuyertStatus: string | null;
  respondedAt: string;
}

export interface ZatcaComplianceAttempt {
  id: string;
  documentType: ZatcaComplianceDocumentType;
  invoiceFamily: string;
  correlationId: string | null;
  rawStatus: string | null;
  normalizedOutcome: string | null;
  attemptedAt: string;
  errorCategory: string | null;
}

export interface ZatcaProductionCsidRequestResult {
  requestId: string;
  dispositionMessage: string;
}

export type ZatcaProductionCsidRenewalOutcome = "issued" | "not_compliant";

export interface ZatcaProductionCsidRenewalResult {
  requestId: string;
  dispositionMessage: string;
  outcome: ZatcaProductionCsidRenewalOutcome;
}

export type ZatcaProviderOperationType = "production_csid_onboarding" | "production_csid_renewal";
export type ZatcaProviderOperationInternalStatus = "response_received" | "failed";

export interface ZatcaProviderOperation {
  id: string;
  operationType: ZatcaProviderOperationType;
  internalStatus: ZatcaProviderOperationInternalStatus;
  providerRequestId: string | null;
  dispositionMessage: string | null;
  providerOutcome: string | null;
  errorCategory: string | null;
  startedAt: string;
  finishedAt: string;
}
