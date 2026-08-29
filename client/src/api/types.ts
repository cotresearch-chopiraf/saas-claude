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

export type ProjectStatus = "active" | "on_hold" | "completed";

export interface Project {
  id: string;
  companyId: string;
  name: string;
  clientName: string | null;
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

export interface CompanyMember {
  id: string;
  name: string;
  email: string;
  role: CompanyRole;
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
