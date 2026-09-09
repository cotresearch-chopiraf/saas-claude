import {
  pgTable,
  uuid,
  text,
  timestamp,
  numeric,
  date,
  integer,
  jsonb,
  pgEnum,
  uniqueIndex,
  index,
  check,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

// Every optional feature this product ships lives as a key here, off or on
// per company — a customer who doesn't want invoicing (or any future add-on)
// switches it off from settings instead of just not clicking on it.
export interface CompanyFeatureFlags {
  invoicing: boolean;
}

export const defaultFeatureFlags: CompanyFeatureFlags = {
  invoicing: true,
};

export const projectStatusEnum = pgEnum("project_status", [
  "active",
  "on_hold",
  "completed",
]);

export const taskStatusEnum = pgEnum("task_status", [
  "todo",
  "in_progress",
  "done",
]);

export const userRoleEnum = pgEnum("user_role", ["owner", "member"]);
// MIDAD Phase A — explicit account status, additive. Every user predates
// this column and defaults to "active" — no backfill/migration logic
// needed. See middleware/auth.ts's requireAuth for the enforcement point:
// this is re-read from the database on every authenticated request (the
// exact same "DB is authoritative every request" discipline
// lib/permissions.ts's getUserRole already established for role), so a
// deactivation takes effect on the user's very next request, not only
// after their existing JWT (7-day lifetime) happens to expire.
export const userStatusEnum = pgEnum("user_status", ["active", "deactivated"]);

export const changeOrderStatusEnum = pgEnum("change_order_status", [
  "pending",
  "approved",
  "rejected",
]);

export const quoteStatusEnum = pgEnum("quote_status", [
  "draft",
  "sent",
  "accepted",
  "rejected",
]);

// Each document picks its own language independently — the same contractor
// might send an Arabic devis to one client and a French one to another.
export const documentLanguageEnum = pgEnum("document_language", ["ar", "fr", "en"]);

export const invoiceStatusEnum = pgEnum("invoice_status", [
  "draft",
  "sent",
  "paid",
]);

// --- Tax & Compliance Engine ---
// GCC-first, Morocco as an additional country pack. See lib/compliance/ for
// the country-agnostic engine and lib/compliance/packs/ for each country's
// rules. Nothing here hard-codes a rate — every number lives inside a
// versioned compliance_rule_versions row, and every company's active
// configuration is official-default + optional-override, never a straight
// overwrite (see companyTaxOverrides below).
export const countryCodeEnum = pgEnum("country_code", ["SA", "AE", "QA", "KW", "BH", "OM", "MA"]);

export const complianceStatusEnum = pgEnum("compliance_status", [
  "configured",
  "partially_configured",
  "review_required",
]);

export const ruleVersionStatusEnum = pgEnum("rule_version_status", ["draft", "published", "superseded"]);

export const sourceTypeEnum = pgEnum("source_type", [
  "official_government",
  "official_regulation",
  "verified_professional",
]);

export const overrideStatusEnum = pgEnum("override_status", ["active", "reset"]);

// A company is the tenant boundary — every other table hangs off it,
// and every query in the app is scoped by companyId to keep tenants isolated.
export const companies = pgTable("companies", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  // Branding + fiscal identity used to auto-fill every quote/invoice letterhead.
  logoPath: text("logo_path"),
  address: text("address"),
  taxId: text("tax_id"),
  phone: text("phone"),
  defaultTaxRatePercent: numeric("default_tax_rate_percent", { precision: 5, scale: 2 })
    .notNull()
    .default("0"),
  // Sequential, gapless-per-company numbering (INV-2026-0001 style) — see
  // lib/numbering.ts for the atomic increment that generates the next one.
  // Starts at 0, not 1: claiming atomically does `x = x + 1 RETURNING x`, so
  // the first number handed out is 1 (a default of 1 would hand out 2 first).
  nextQuoteNumber: integer("next_quote_number").notNull().default(0),
  nextInvoiceNumber: integer("next_invoice_number").notNull().default(0),
  featureFlags: jsonb("feature_flags").$type<CompanyFeatureFlags>().notNull().default(defaultFeatureFlags),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name").notNull(),
  role: userRoleEnum("role").notNull().default("owner"),
  status: userStatusEnum("status").notNull().default("active"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Session revocation for regular (tenant) users — same "row per issued
// token, revokedAt checked on every request" pattern already proven for
// platform support sessions (see supportSessions below). A 7-day JWT alone
// only proves who signed in, not whether that specific token should still
// work right now; without this, a leaked token or a member removed by the
// owner keeps working for up to 7 more days. id doubles as the JWT's "sid"
// claim (lib/jwt.ts), so revoking a row immediately invalidates the one
// token issued for it.
export const userSessions = pgTable(
  "user_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    revokedAt: timestamp("revoked_at"),
  },
  (table) => ({
    userIdx: index("user_sessions_user_idx").on(table.userId),
  }),
);

export const projects = pgTable(
  "projects",
  {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  clientName: text("client_name"),
  // MIDAD Phase A' — optional link to the first-class Customer entity
  // (defined further below in this file). Deliberately additive and
  // independent of clientName: existing/new projects may keep using the
  // free-text clientName exactly as before, set customerId instead, both,
  // or neither — this route never auto-populates one from the other.
  // set null on delete: there is no delete route for customers today, but
  // the FK stays defensively non-blocking, matching the same pattern used
  // for invoices.projectId/contractId.
  customerId: uuid("customer_id").references((): AnyPgColumn => customers.id, { onDelete: "set null" }),
  address: text("address"),
  status: projectStatusEnum("status").notNull().default("active"),
  // LEGACY, non-authoritative. Predates Contract/BOQ/BudgetItems entirely
  // (the original MVP's only notion of "the project's money"). Kept for
  // backward compatibility and display only — see
  // docs/MIDAD_FINANCIAL_MODEL.md for the canonical financial model this
  // does NOT participate in. Its only sanctioned writer is change-order
  // approval's atomic SQL increment (changeOrders.ts); the normal project
  // update route (routes/projects.ts) deliberately excludes it from its
  // schema so it cannot be set through that path at all, by any role.
  // Never read by Contract, BOQ, BudgetItems, or anything Phase 2 builds
  // (Commitment, Actual Cost, Forecast, Cash Flow) — budgetItems.plannedAmount
  // is the canonical Cost Plan those depend on instead.
  budgetTotal: numeric("budget_total", { precision: 12, scale: 2 })
    .notNull()
    .default("0"),
  startDate: date("start_date"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    // Slice Z — every tenant-scoped list route filters projects by
    // companyId (see routes/projects.ts); this was the one column every
    // downstream project-scoped table's own tenant-ownership check
    // ultimately depends on, and it had no explicit index before this.
    companyIdx: index("projects_company_idx").on(table.companyId),
  }),
);

// This table's plannedAmount is the canonical Cost Plan / expected-cost
// baseline for this product — the number future Commitment, Actual Cost,
// and Forecast logic computes variance against, grouped by project, cost
// code, BOQ item, and/or budget revision. It is NOT the same figure as
// Contract value (contracts.revisedValue — contractual/revenue value) or
// published BOQ value (Σ boqItems.amount — contractual scope valuation);
// see docs/MIDAD_FINANCIAL_MODEL.md for why these three are kept distinct
// rather than collapsed into one generic "budget" number.
export const budgetItems = pgTable(
  "budget_items",
  {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  // Free-text category is the original MVP field and stays exactly as it
  // was — existing rows and the existing UI keep working unchanged. The
  // three columns below are optional (nullable) MIDAD Foundation additions:
  // a budget item can now *also* be tagged to a canonical cost code and/or
  // a BOQ item, and grouped under a budget revision, without requiring any
  // existing budget item to have them. See the "MIDAD Phase 1 — Foundation"
  // section near the end of this file for what each referenced table is.
  category: text("category").notNull(),
  plannedAmount: numeric("planned_amount", { precision: 12, scale: 2 }).notNull(),
  costCodeId: uuid("cost_code_id").references((): AnyPgColumn => costCodes.id),
  boqItemId: uuid("boq_item_id").references((): AnyPgColumn => boqItems.id),
  budgetRevisionId: uuid("budget_revision_id").references((): AnyPgColumn => budgetRevisions.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    // Slice Z — every budget/cost-plan list route filters by projectId
    // alone (companyId is validated once against the parent project
    // before this query runs — see routes/budget.ts).
    projectIdx: index("budget_items_project_idx").on(table.projectId),
  }),
);

export const expenses = pgTable(
  "expenses",
  {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  budgetItemId: uuid("budget_item_id").references(() => budgetItems.id, {
    onDelete: "set null",
  }),
  // Phase A (Mudad/WPS + Project Labor Cost) — nullable, additive. Lets an
  // expense be grouped by cost code directly (labor postings always set
  // this; existing manual expenses stay unaffected, this column is never
  // backfilled). Deliberately NOT required to match budgetItemId's own
  // costCodeId when both are set — an expense may be tagged to a cost
  // code with no corresponding budget item yet. See the Phase A section
  // near the end of this file for the labor-cost posting flow that writes
  // rows here (laborCostPostings -> expenses, never a second actual-cost
  // table); collectForecastInputs/calculateForecast/calculateCashFlow are
  // unchanged by this column — they still just SUM(expenses.amount).
  costCodeId: uuid("cost_code_id").references((): AnyPgColumn => costCodes.id),
  description: text("description").notNull(),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  expenseDate: date("expense_date").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    // Slice Z — same pattern as budget_items above (routes/budget.ts).
    projectIdx: index("expenses_project_idx").on(table.projectId),
  }),
);

export const tasks = pgTable(
  "tasks",
  {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  assigneeName: text("assignee_name"),
  dueDate: date("due_date"),
  status: taskStatusEnum("status").notNull().default("todo"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    // Slice Z — routes/tasks.ts filters its list route by projectId alone.
    projectIdx: index("tasks_project_idx").on(table.projectId),
  }),
);

// Renovation scope changes constantly — this is the #1 workflow gap this
// product exists to close. Approving a change order shifts the project's
// LEGACY budgetTotal by amountDelta (see the route handler) — this is the
// one sanctioned writer of that field, kept exactly as it was; it does not
// touch Contract, BOQ, or BudgetItems (see docs/MIDAD_FINANCIAL_MODEL.md).
export const changeOrders = pgTable(
  "change_orders",
  {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description"),
  amountDelta: numeric("amount_delta", { precision: 12, scale: 2 }).notNull(),
  status: changeOrderStatusEnum("status").notNull().default("pending"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    // Slice Z — routes/changeOrders.ts filters its list route by projectId
    // alone.
    projectIdx: index("change_orders_project_idx").on(table.projectId),
  }),
);

// The single most-cited strength of the market leader (Buildertrend) is its
// site activity / daily log feature — this is the lightweight MVP version.
export const dailyLogs = pgTable(
  "daily_logs",
  {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  note: text("note").notNull(),
  logDate: date("log_date").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    // Slice Z — routes/dailyLogs.ts filters its list route by projectId
    // alone.
    projectIdx: index("daily_logs_project_idx").on(table.projectId),
  }),
);

// Reset flows never leak whether an email exists — the route always answers
// the same way. Only a hash of the token is stored, so a DB leak alone can't
// be used to take over an account; expiresAt caps the exposure window.
export const passwordResetTokens = pgTable("password_reset_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// One company can have several users (owner + members) — an invite is how a
// second person joins an existing company instead of creating a new one.
export const companyInvites = pgTable(
  "company_invites",
  {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: userRoleEnum("role").notNull().default("member"),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  acceptedAt: timestamp("accepted_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    // Slice Z — routes/company.ts's GET /invites filters by companyId.
    companyIdx: index("company_invites_company_idx").on(table.companyId),
  }),
);

// A quote precedes a project — it's the estimate a contractor sends before
// work (and money) starts. publicToken lets the client view/accept it
// without an account, which is the whole point of a client-facing quote.
export const quotes = pgTable(
  "quotes",
  {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  quoteNumber: text("quote_number"),
  clientName: text("client_name").notNull(),
  clientEmail: text("client_email"),
  projectName: text("project_name").notNull(),
  language: documentLanguageEnum("language").notNull().default("ar"),
  status: quoteStatusEnum("status").notNull().default("draft"),
  // Tax is optional on a quote (a company with no compliance profile
  // configured yet keeps working exactly as before — plain line-item sum,
  // no tax fields). When the tax engine computed a result for this quote,
  // these columns are the frozen snapshot of what it computed and why, so
  // a later rule/override change never rewrites an already-created quote.
  taxCategory: text("tax_category"),
  taxRatePercent: numeric("tax_rate_percent", { precision: 5, scale: 2 }),
  ruleVersionId: uuid("rule_version_id").references(() => complianceRuleVersions.id),
  overrideReference: uuid("override_reference").references(() => companyTaxOverrides.id),
  publicToken: text("public_token").notNull().unique(),
  acceptedByName: text("accepted_by_name"),
  acceptedAt: timestamp("accepted_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    // Slice Z — routes/quotes.ts's company-wide GET / filters by
    // companyId alone.
    companyIdx: index("quotes_company_idx").on(table.companyId),
  }),
);

export const quoteItems = pgTable("quote_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  quoteId: uuid("quote_id")
    .notNull()
    .references(() => quotes.id, { onDelete: "cascade" }),
  description: text("description").notNull(),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// An invoice can stand alone or trace back to the quote that won the job —
// either way it carries its own frozen snapshot of the tax rate, so a later
// change to the company's default rate never rewrites an already-issued
// invoice (a hard requirement everywhere VAT/tax invoices are regulated).
export const invoices = pgTable(
  "invoices",
  {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  quoteId: uuid("quote_id").references(() => quotes.id, { onDelete: "set null" }),
  // MIDAD Phase 2E foundation — both nullable, added additively on top of
  // every existing invoice (which keeps working exactly as before with
  // both left NULL — an "unallocated" company-level invoice remains valid
  // product behavior, not a data-quality problem to fix). Never populated
  // by matching quotes.projectName (free text) against projects.name —
  // that would be a non-deterministic heuristic, not a real relationship.
  // Only a route that independently validates both FKs against the
  // caller's company (and, when both are supplied, contract.projectId ===
  // this projectId) may ever set them — see routes/invoices.ts. This is
  // what makes Σ invoices reliably project-scopable for Cash Flow
  // (Phase 2E), closing the gap the Phase 2E discovery report identified.
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
  contractId: uuid("contract_id").references((): AnyPgColumn => contracts.id, { onDelete: "set null" }),
  invoiceNumber: text("invoice_number").notNull(),
  clientName: text("client_name").notNull(),
  clientAddress: text("client_address"),
  clientTaxId: text("client_tax_id"),
  taxRatePercent: numeric("tax_rate_percent", { precision: 5, scale: 2 }).notNull(),
  // Same historical-snapshot purpose as on quotes above — nullable because
  // an invoice created before the tax engine existed, or by a company with
  // no compliance profile configured, has none of this and still works
  // exactly as before off the existing taxRatePercent column alone.
  taxCategory: text("tax_category"),
  ruleVersionId: uuid("rule_version_id").references(() => complianceRuleVersions.id),
  overrideReference: uuid("override_reference").references(() => companyTaxOverrides.id),
  language: documentLanguageEnum("language").notNull().default("ar"),
  status: invoiceStatusEnum("status").notNull().default("draft"),
  publicToken: text("public_token").notNull().unique(),
  issueDate: date("issue_date").notNull(),
  dueDate: date("due_date"),
  paidAt: timestamp("paid_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    // Slice Z — composite, not two separate indexes: routes/invoices.ts's
    // company-wide GET / filters by companyId alone (uses the leading
    // column), while the project-scoped GET (projectInvoicesRouter) filters
    // by companyId AND projectId together — one composite index serves
    // both query shapes.
    companyProjectIdx: index("invoices_company_project_idx").on(table.companyId, table.projectId),
  }),
);

export const invoiceItems = pgTable("invoice_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  invoiceId: uuid("invoice_id")
    .notNull()
    .references(() => invoices.id, { onDelete: "cascade" }),
  description: text("description").notNull(),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// One immutable, versioned snapshot of a country's compliance rules. Never
// mutated once published — a regulation change produces a NEW row (a new
// version), it never rewrites an old one. `rules` is a structured JSONB
// payload (see lib/compliance/types.ts for the shape every country pack
// must produce) rather than a fully relational schema, because the actual
// shape of "what a country's tax rules look like" genuinely varies enough
// (Zakat only applies in some, withholding tables differ, e-invoicing
// requirements differ) that forcing one rigid relational shape across 7
// jurisdictions up front would either be wrong for most of them or would
// need a schema migration every time a country's rules turn out to need one
// more field. The document is still queryable via Postgres JSONB operators
// when a report genuinely needs to reach into it.
export const complianceRuleVersions = pgTable("compliance_rule_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  countryCode: countryCodeEnum("country_code").notNull(),
  version: text("version").notNull(),
  status: ruleVersionStatusEnum("status").notNull().default("draft"),
  effectiveFrom: date("effective_from").notNull(),
  effectiveTo: date("effective_to"),
  rules: jsonb("rules").notNull(),
  // Provenance — see lib/compliance/types.ts ComplianceRules for what's
  // actually inside `rules`; these columns are about where that content
  // came from, required for auditability (mission-provided requirement:
  // never invent a citation, never claim verification that didn't happen).
  sourceUrl: text("source_url"),
  sourceType: sourceTypeEnum("source_type"),
  publicationDate: date("publication_date"),
  retrievedAt: timestamp("retrieved_at"),
  verificationStatus: text("verification_status").notNull().default("unverified"),
  publishedAt: timestamp("published_at"),
  publishedBy: uuid("published_by").references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// One row per company: which country/entity/activity it's configured for,
// and which published rule version is currently active for it. This is the
// company-level compliance profile — the architecture intentionally leaves
// room for a future branchId (nullable, added later) without a redesign,
// but does not implement multi-branch tax profiles in this phase: nothing
// else in this schema (projects, invoices, quotes) is branch-scoped today,
// and retrofitting that everywhere is out of scope for the tax engine
// itself. See the implementation report for this explicit scope decision.
export const companyComplianceProfiles = pgTable("company_compliance_profiles", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .unique()
    .references(() => companies.id, { onDelete: "cascade" }),
  countryCode: countryCodeEnum("country_code").notNull(),
  legalEntityType: text("legal_entity_type"),
  businessActivity: text("business_activity"),
  taxRegistrationStatus: text("tax_registration_status"),
  activeRuleVersionId: uuid("active_rule_version_id")
    .notNull()
    .references(() => complianceRuleVersions.id),
  status: complianceStatusEnum("status").notNull().default("configured"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// The override layer. A row here NEVER mutates the country pack (that
// stays in compliance_rule_versions, untouched) — it's a company-scoped
// exception on top of it. `settingKey` is a dotted path into the rule
// document (e.g. "vat.standardRatePercent"). Resetting an override does
// NOT delete this row — it flips status to "reset" and stamps who/when, so
// the audit history survives the reset (mission-required invariant).
// TC-03 fix: a partial unique index enforces at the database level that a
// company can have at most one OPEN-ENDED active override (effectiveTo IS
// NULL) per settingKey at a time. Multiple *closed* (effectiveTo set)
// status='active' rows are still allowed to coexist — that's the
// intentional historical-timeline design (see createOverride() in
// lib/compliance/overrides.ts): closing the prior row and inserting the
// new one is two statements, not one atomic operation, so two concurrent
// createOverride calls could previously both read "no prior active" and
// both insert an open-ended row — this index makes the second INSERT fail
// with a unique-violation instead of silently succeeding (reproduced live
// in the tax-engine red-team audit, TC-03).
export const companyTaxOverrides = pgTable(
  "company_tax_overrides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    settingKey: text("setting_key").notNull(),
    overrideValue: jsonb("override_value").notNull(),
    // What the official default WAS at the moment this override was created —
    // kept alongside the override so the UI can always show "official vs.
    // company" even if the country pack itself is later superseded by a new
    // version with a different default.
    officialDefaultSnapshot: jsonb("official_default_snapshot").notNull(),
    ruleVersionId: uuid("rule_version_id")
      .notNull()
      .references(() => complianceRuleVersions.id),
    status: overrideStatusEnum("status").notNull().default("active"),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    reason: text("reason"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    resetAt: timestamp("reset_at"),
    resetBy: uuid("reset_by").references(() => users.id),
  },
  (table) => ({
    oneOpenActivePerSetting: uniqueIndex("company_tax_overrides_one_open_active")
      .on(table.companyId, table.settingKey)
      .where(sql`${table.status} = 'active' AND ${table.effectiveTo} IS NULL`),
  }),
);

// Append-only. No route ever exposes an UPDATE or DELETE against this
// table — every sensitive compliance mutation writes exactly one row here
// in the same transaction as the mutation itself (see lib/compliance for
// the helper that guarantees this), and that is the entire audit trail.
export const complianceAuditEvents = pgTable("compliance_audit_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  eventType: text("event_type").notNull(),
  settingKey: text("setting_key"),
  previousValue: jsonb("previous_value"),
  newValue: jsonb("new_value"),
  officialDefaultAtTime: jsonb("official_default_at_time"),
  countryCode: countryCodeEnum("country_code"),
  ruleVersionId: uuid("rule_version_id").references(() => complianceRuleVersions.id),
  changedBy: uuid("changed_by")
    .notNull()
    .references(() => users.id),
  reason: text("reason"),
  effectiveFrom: date("effective_from"),
  effectiveTo: date("effective_to"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// A company's actual registered identifiers (VAT number, commercial
// registration, e-invoicing ID, ...). Which identifierType values are
// relevant/required for a given company is decided by its country pack
// (getRequiredFields()), not hard-coded here.
export const companyTaxIdentifiers = pgTable("company_tax_identifiers", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  identifierType: text("identifier_type").notNull(),
  value: text("value").notNull(),
  countryCode: countryCodeEnum("country_code").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const companiesRelations = relations(companies, ({ many }) => ({
  users: many(users),
  projects: many(projects),
  invites: many(companyInvites),
  quotes: many(quotes),
  invoices: many(invoices),
}));

export const invoicesRelations = relations(invoices, ({ one, many }) => ({
  company: one(companies, {
    fields: [invoices.companyId],
    references: [companies.id],
  }),
  quote: one(quotes, {
    fields: [invoices.quoteId],
    references: [quotes.id],
  }),
  project: one(projects, {
    fields: [invoices.projectId],
    references: [projects.id],
  }),
  contract: one(contracts, {
    fields: [invoices.contractId],
    references: [contracts.id],
  }),
  items: many(invoiceItems),
}));

export const invoiceItemsRelations = relations(invoiceItems, ({ one }) => ({
  invoice: one(invoices, {
    fields: [invoiceItems.invoiceId],
    references: [invoices.id],
  }),
}));

export const quotesRelations = relations(quotes, ({ one, many }) => ({
  company: one(companies, {
    fields: [quotes.companyId],
    references: [companies.id],
  }),
  items: many(quoteItems),
}));

export const quoteItemsRelations = relations(quoteItems, ({ one }) => ({
  quote: one(quotes, {
    fields: [quoteItems.quoteId],
    references: [quotes.id],
  }),
}));

export const projectsRelations = relations(projects, ({ one, many }) => ({
  company: one(companies, {
    fields: [projects.companyId],
    references: [companies.id],
  }),
  customer: one(customers, {
    fields: [projects.customerId],
    references: [customers.id],
  }),
  budgetItems: many(budgetItems),
  expenses: many(expenses),
  tasks: many(tasks),
  changeOrders: many(changeOrders),
  dailyLogs: many(dailyLogs),
}));

export const changeOrdersRelations = relations(changeOrders, ({ one }) => ({
  project: one(projects, {
    fields: [changeOrders.projectId],
    references: [projects.id],
  }),
}));

export const dailyLogsRelations = relations(dailyLogs, ({ one }) => ({
  project: one(projects, {
    fields: [dailyLogs.projectId],
    references: [projects.id],
  }),
}));

export const budgetItemsRelations = relations(budgetItems, ({ one, many }) => ({
  project: one(projects, {
    fields: [budgetItems.projectId],
    references: [projects.id],
  }),
  expenses: many(expenses),
}));

export const expensesRelations = relations(expenses, ({ one }) => ({
  project: one(projects, {
    fields: [expenses.projectId],
    references: [projects.id],
  }),
  budgetItem: one(budgetItems, {
    fields: [expenses.budgetItemId],
    references: [budgetItems.id],
  }),
  costCode: one(costCodes, {
    fields: [expenses.costCodeId],
    references: [costCodes.id],
  }),
}));

export const tasksRelations = relations(tasks, ({ one }) => ({
  project: one(projects, {
    fields: [tasks.projectId],
    references: [projects.id],
  }),
}));

export const companyComplianceProfilesRelations = relations(companyComplianceProfiles, ({ one }) => ({
  company: one(companies, {
    fields: [companyComplianceProfiles.companyId],
    references: [companies.id],
  }),
  activeRuleVersion: one(complianceRuleVersions, {
    fields: [companyComplianceProfiles.activeRuleVersionId],
    references: [complianceRuleVersions.id],
  }),
}));

export const companyTaxOverridesRelations = relations(companyTaxOverrides, ({ one }) => ({
  company: one(companies, {
    fields: [companyTaxOverrides.companyId],
    references: [companies.id],
  }),
  ruleVersion: one(complianceRuleVersions, {
    fields: [companyTaxOverrides.ruleVersionId],
    references: [complianceRuleVersions.id],
  }),
}));

export const complianceAuditEventsRelations = relations(complianceAuditEvents, ({ one }) => ({
  company: one(companies, {
    fields: [complianceAuditEvents.companyId],
    references: [companies.id],
  }),
}));

// =============================================================================
// MIDAD Phase 1 — Foundation: Contract, BOQ, Cost Code, Budget Revision,
// canonical audit trail, evidence/file metadata.
//
// Scope discipline (per the approved Phase 1 plan): this is the FOUNDATION
// only. Procurement, Commitment, Progress, Measurement, IPC, Forecast are
// NOT built here — the tables below exist so those later phases have
// something real to attach to, not to implement them now. Nothing here
// touches or replaces the existing projects/budgetItems/expenses/
// changeOrders tables' current behavior; budgetItems gained three nullable
// columns above and nothing else changed.
// =============================================================================

// --- Cost Codes ---
// A canonical hierarchy, company-scoped. projectId is nullable: null means
// a company-wide standard code (e.g. "01 Labor"), reusable across every
// project; a non-null projectId is a project-specific extension that does
// not pollute the company's global list for other projects — this is the
// "project-specific extensions without breaking global standards"
// requirement from the approved plan, and the reason this is one table
// with a nullable scoping column rather than two separate tables.
export const costCodeCategoryEnum = pgEnum("cost_code_category", [
  "labor",
  "materials",
  "equipment",
  "subcontract",
  "site_overhead",
  "general_overhead",
  "other",
]);

export const costCodes = pgTable(
  "cost_codes",
  {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  name: text("name").notNull(),
  category: costCodeCategoryEnum("category"),
  parentCostCodeId: uuid("parent_cost_code_id").references((): AnyPgColumn => costCodes.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    // Slice Z — routes/costCodes.ts's list route always filters by
    // companyId (projectId is an optional additional filter on top of it,
    // never used alone) — see the route's own where clause.
    companyIdx: index("cost_codes_company_idx").on(table.companyId),
  }),
);

// --- Contracts ---
// Organization -> Project -> Contract, exactly as approved. contractType
// distinguishes a project's primary commercial instrument ("main") from a
// later amendment to it ("amendment", self-referencing parentContractId) —
// deliberately NOT trying to also represent subcontracts or change orders
// in this same table (those are separate, larger domains explicitly
// deferred to later phases; change_orders already exists and is untouched).
// revisedValue starts equal to originalValue and is expected to move only
// through an explicit, audited amendment — never edited in place silently.
// revisedValue is the canonical CURRENT CONTRACT VALUE — the contractual/
// revenue figure. It is a distinct concept from the Cost Plan
// (budgetItems.plannedAmount) and from BOQ scope valuation (Σ boqItems.amount);
// see docs/MIDAD_FINANCIAL_MODEL.md.
export const contractTypeEnum = pgEnum("contract_type", ["main", "amendment"]);
export const contractStatusEnum = pgEnum("contract_status", ["draft", "active", "completed", "terminated"]);

export const contracts = pgTable(
  "contracts",
  {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  contractType: contractTypeEnum("contract_type").notNull().default("main"),
  parentContractId: uuid("parent_contract_id").references((): AnyPgColumn => contracts.id),
  contractNumber: text("contract_number"),
  clientName: text("client_name"),
  originalValue: numeric("original_value", { precision: 14, scale: 2 }).notNull(),
  revisedValue: numeric("revised_value", { precision: 14, scale: 2 }).notNull(),
  currency: text("currency").notNull().default("SAR"),
  advancePercent: numeric("advance_percent", { precision: 5, scale: 2 }),
  retentionPercent: numeric("retention_percent", { precision: 5, scale: 2 }),
  paymentTerms: text("payment_terms"),
  status: contractStatusEnum("status").notNull().default("draft"),
  startDate: date("start_date"),
  endDate: date("end_date"),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    // Slice Z — routes/contracts.ts's list route filters by projectId
    // alone (companyId is validated once against the parent project
    // before this query runs).
    projectIdx: index("contracts_project_idx").on(table.projectId),
  }),
);

// --- BOQ ---
// Versioned exactly like compliance_rule_versions: a revision is immutable
// once published — a change produces a NEW boq_revisions row (status
// "superseded" on the old one via supersedesRevisionId), it never rewrites
// boq_items belonging to an already-published revision. itemType
// distinguishes a grouping/header row ("section") from a real billable
// line ("item") — hierarchy and "sections" are the same mechanism
// (parentItemId), not two competing ones.
export const boqRevisionStatusEnum = pgEnum("boq_revision_status", ["draft", "published", "superseded"]);
export const boqItemTypeEnum = pgEnum("boq_item_type", ["section", "item"]);

export const boqRevisions = pgTable(
  "boq_revisions",
  {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  contractId: uuid("contract_id")
    .notNull()
    .references(() => contracts.id, { onDelete: "cascade" }),
  revisionNumber: integer("revision_number").notNull(),
  status: boqRevisionStatusEnum("status").notNull().default("draft"),
  supersedesRevisionId: uuid("supersedes_revision_id").references((): AnyPgColumn => boqRevisions.id),
  notes: text("notes"),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  publishedAt: timestamp("published_at"),
  },
  (table) => ({
    // Slice Z — routes/boq.ts's list route filters by projectId alone.
    projectIdx: index("boq_revisions_project_idx").on(table.projectId),
    // Phase 3.2 remediation (DB-001) — defense-in-depth backstop for the
    // per-contract sequential numbering routes/boq.ts already claims
    // atomically via a contract-row-locked MAX+1 subquery.
    revisionNumberUnique: uniqueIndex("boq_revisions_contract_revision_unique").on(
      table.contractId,
      table.revisionNumber,
    ),
  }),
);

export const boqItems = pgTable("boq_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  boqRevisionId: uuid("boq_revision_id")
    .notNull()
    .references(() => boqRevisions.id, { onDelete: "cascade" }),
  parentItemId: uuid("parent_item_id").references((): AnyPgColumn => boqItems.id),
  itemType: boqItemTypeEnum("item_type").notNull().default("item"),
  code: text("code"),
  description: text("description").notNull(),
  unit: text("unit"),
  quantity: numeric("quantity", { precision: 14, scale: 3 }),
  rate: numeric("rate", { precision: 14, scale: 2 }),
  // Stored, not derived on every read — computed once at write time via
  // lib/money.ts (same frozen-computation discipline as invoice/quote
  // totals) so a BOQ item's amount is exact and doesn't depend on
  // recomputing quantity*rate correctly at every call site.
  amount: numeric("amount", { precision: 14, scale: 2 }),
  costCodeId: uuid("cost_code_id").references(() => costCodes.id),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// --- Budget Revisions ---
// An ADDITIVE versioning/approval layer on top of the existing budget_items
// table (the canonical Cost Plan — see the comment above budgetItems). A
// budget revision here means "we approved a new allocation of the budget
// across cost codes" (e.g. a transfer from Materials to Labor) — not "the
// total contract value changed" (that is what a contract amendment
// represents; see docs/MIDAD_FINANCIAL_MODEL.md for the full distinction).
// This intentionally does not touch the legacy projects.budgetTotal field
// (see the comment on that column) or the already-working, concurrency-
// hardened change-order code (changeOrders.ts) — conflating budget-item
// reallocation with either would have meant redesigning tested code the
// Phase 1 plan's risk posture explicitly steered away from touching.
export const budgetRevisionStatusEnum = pgEnum("budget_revision_status", ["draft", "approved", "superseded"]);

export const budgetRevisions = pgTable(
  "budget_revisions",
  {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  revisionNumber: integer("revision_number").notNull(),
  status: budgetRevisionStatusEnum("status").notNull().default("draft"),
  reason: text("reason"),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  approvedBy: uuid("approved_by").references(() => users.id),
  approvedAt: timestamp("approved_at"),
  },
  (table) => ({
    // Slice Z — routes/budgetRevisions.ts's list route filters by
    // projectId alone.
    projectIdx: index("budget_revisions_project_idx").on(table.projectId),
    // Phase 3.2 remediation (DB-001) — defense-in-depth backstop for the
    // per-project sequential numbering routes/budgetRevisions.ts already
    // claims atomically via a project-row-locked MAX+1 subquery; this
    // constraint doesn't replace that lock (it can't provide the "claim
    // the next number" behavior on its own), it only guarantees the DB
    // itself will reject a duplicate if that discipline is ever bypassed.
    revisionNumberUnique: uniqueIndex("budget_revisions_project_revision_unique").on(
      table.projectId,
      table.revisionNumber,
    ),
  }),
);

// --- Canonical audit trail ---
// One audit-event model for the whole product going forward, per the
// approved decision to generalize now rather than let every domain grow
// its own audit table. compliance_audit_events (above) is NOT dropped and
// NOT migrated — it keeps every row it already has, exactly as-is, so no
// historical compliance audit data is touched — but it is deprecated: the
// compliance module's audit-writing code now targets this table instead
// (see lib/audit.ts and the updated lib/compliance/audit.ts). Every new
// domain (Contract, BOQ, Cost Code, Budget Revision, and everything later)
// writes here, keyed by entityType/entityId rather than one column set per
// domain — this is intentionally NOT event-sourcing (no replay, no event
// stream is the source of truth for current state; current state always
// lives in its own table, this is only the trail of who-changed-what-when).
export const auditEvents = pgTable(
  "audit_events",
  {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  // Nullable: a future system/AI-originated event (source below) may have
  // no human actor — never fabricate one to satisfy a NOT NULL constraint.
  actorUserId: uuid("actor_user_id").references(() => users.id),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: uuid("entity_id").notNull(),
  beforeValue: jsonb("before_value"),
  afterValue: jsonb("after_value"),
  reason: text("reason"),
  source: text("source").notNull().default("api"),
  // Domain-specific extras that don't deserve their own first-class column
  // on a shared table (e.g. compliance's ruleVersionId/countryCode) — kept
  // here instead of forcing every future domain's audit needs into this
  // table's fixed column set.
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    // Slice Z — every audit-event read path (routes/auditEvents.ts,
    // lib/audit.ts's listCompanyActivity) filters by companyId first.
    companyIdx: index("audit_events_company_idx").on(table.companyId),
  }),
);

// --- Evidence / file metadata ---
// Metadata only — never the file bytes themselves (per the approved
// decision). storageProvider + storageKey are the abstraction boundary:
// today only "local" (the existing multer-disk mechanism, now wrapped
// behind lib/storage/ instead of called directly) is implemented, but nothing
// about this table's shape assumes local disk — an "s3" provider later is
// an additive enum value and a new lib/storage/ implementation, not a
// schema change. A new version of an evidence file is a NEW row
// (previousVersionId points back) — no route ever updates storageKey on an
// existing row, so historical evidence is never silently replaced.
// Slice AA — "s3" added: any S3-compatible object store (see
// lib/storage/s3Provider.ts). Purely additive — existing "local" rows are
// unaffected.
export const storageProviderEnum = pgEnum("storage_provider", ["local", "s3"]);

export const files = pgTable(
  "files",
  {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  storageProvider: storageProviderEnum("storage_provider").notNull().default("local"),
  storageKey: text("storage_key").notNull(),
  fileName: text("file_name").notNull(),
  mimeType: text("mime_type").notNull(),
  size: integer("size").notNull(),
  checksum: text("checksum"),
  uploadedBy: uuid("uploaded_by")
    .notNull()
    .references(() => users.id),
  uploadedAt: timestamp("uploaded_at").notNull().defaultNow(),
  entityType: text("entity_type").notNull(),
  entityId: uuid("entity_id").notNull(),
  version: integer("version").notNull().default(1),
  previousVersionId: uuid("previous_version_id").references((): AnyPgColumn => files.id),
  },
  (table) => ({
    // Slice Z — routes/documents.ts's list route filters by companyId
    // (and entityType/entityId) — companyId is the leading, most-selective
    // filter every document-access path checks first.
    companyIdx: index("files_company_idx").on(table.companyId),
  }),
);

// --- Idempotency ledger ---
// Slice AA Scope E — generic idempotency-key ledger for the two mutations
// identified as genuinely duplicate-risk (invoice/quote creation: a network
// retry or a double-click must never create two financial documents). Keyed
// per (companyId, operation, key) so no two tenants' keys can ever collide,
// and a request-body fingerprint so the SAME key reused with a materially
// different payload is rejected instead of silently replaying a stale
// result. This is intentionally separate from ZATCA's own submission-level
// idempotency (zatcaSubmissions' natural-key uniqueness below) — that
// mechanism belongs to the frozen ZATCA compliance architecture and is
// neither reused nor modified here.
export const idempotencyOperationEnum = pgEnum("idempotency_operation", ["invoice.create", "quote.create"]);
export const idempotencyStatusEnum = pgEnum("idempotency_status", ["pending", "completed"]);

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    operation: idempotencyOperationEnum("operation").notNull(),
    key: text("key").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    // "pending" while the leader request is still executing the underlying
    // mutation; a follower polls until this flips to "completed" rather
    // than racing a second write. See lib/idempotency.ts.
    status: idempotencyStatusEnum("status").notNull().default("pending"),
    responseStatus: integer("response_status"),
    responseBody: jsonb("response_body"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    companyOperationKeyUnique: uniqueIndex("idempotency_keys_company_operation_key_unique").on(
      table.companyId,
      table.operation,
      table.key,
    ),
  }),
);

// --- Notifications ---
// Slice AA Scope F — minimal tenant-scoped notification foundation. No
// producer is wired up yet by this slice (F5: build the model + a minimal
// API now; integrate specific event sources — tasks, approvals, invitations,
// ZATCA operational events — only when that work is itself in scope).
// recipientUserId is the sole ownership boundary: every route in
// routes/notifications.ts filters by (companyId, recipientUserId) so a user
// can never read or mark-read another user's notification, even within the
// same company. "type" is deliberately free text, not an enum — the same
// choice audit_events made for its own "action"/"entityType" columns — so a
// future producer never needs a schema migration just to add a new kind of
// notification.
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    recipientUserId: uuid("recipient_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    title: text("title").notNull(),
    message: text("message").notNull(),
    readAt: timestamp("read_at"),
    referenceEntityType: text("reference_entity_type"),
    referenceEntityId: uuid("reference_entity_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    // Every read path (list, unread-count) filters by exactly this triple
    // and orders by createdAt — a single composite index covers both.
    recipientIdx: index("notifications_recipient_idx").on(table.companyId, table.recipientUserId, table.createdAt),
  }),
);

export const costCodesRelations = relations(costCodes, ({ one, many }) => ({
  company: one(companies, { fields: [costCodes.companyId], references: [companies.id] }),
  project: one(projects, { fields: [costCodes.projectId], references: [projects.id] }),
  parent: one(costCodes, { fields: [costCodes.parentCostCodeId], references: [costCodes.id] }),
  budgetItems: many(budgetItems),
  boqItems: many(boqItems),
}));

export const contractsRelations = relations(contracts, ({ one, many }) => ({
  company: one(companies, { fields: [contracts.companyId], references: [companies.id] }),
  project: one(projects, { fields: [contracts.projectId], references: [projects.id] }),
  parentContract: one(contracts, { fields: [contracts.parentContractId], references: [contracts.id] }),
  boqRevisions: many(boqRevisions),
}));

export const boqRevisionsRelations = relations(boqRevisions, ({ one, many }) => ({
  project: one(projects, { fields: [boqRevisions.projectId], references: [projects.id] }),
  contract: one(contracts, { fields: [boqRevisions.contractId], references: [contracts.id] }),
  items: many(boqItems),
}));

export const boqItemsRelations = relations(boqItems, ({ one }) => ({
  revision: one(boqRevisions, { fields: [boqItems.boqRevisionId], references: [boqRevisions.id] }),
  parent: one(boqItems, { fields: [boqItems.parentItemId], references: [boqItems.id] }),
  costCode: one(costCodes, { fields: [boqItems.costCodeId], references: [costCodes.id] }),
}));

export const budgetRevisionsRelations = relations(budgetRevisions, ({ one, many }) => ({
  project: one(projects, { fields: [budgetRevisions.projectId], references: [projects.id] }),
  budgetItems: many(budgetItems),
}));

export const auditEventsRelations = relations(auditEvents, ({ one }) => ({
  company: one(companies, { fields: [auditEvents.companyId], references: [companies.id] }),
  actor: one(users, { fields: [auditEvents.actorUserId], references: [users.id] }),
}));

export const filesRelations = relations(files, ({ one }) => ({
  company: one(companies, { fields: [files.companyId], references: [companies.id] }),
  uploader: one(users, { fields: [files.uploadedBy], references: [users.id] }),
  previousVersion: one(files, { fields: [files.previousVersionId], references: [files.id] }),
}));

// =============================================================================
// MIDAD Phase 2A — Procurement + Supplier + Commitment foundation.
//
// Per the resolved canonical financial model (docs/MIDAD_FINANCIAL_MODEL.md):
// Commitment is CONTRACTED/ORDERED FUTURE COST — a distinct concept from
// Cost Plan (budgetItems.plannedAmount, unchanged, still the canonical
// planning baseline), Contract Value (contracts.revisedValue), and BOQ
// Value (Σ published boqItems.amount). Nothing here reads or writes
// projects.budgetTotal, budgetItems, or contracts.revisedValue — Commitment
// stands on its own, referencing costCodeId/boqItemId the same way
// budgetItems already does, so a future Phase 2B (Actual Cost / Progress /
// Forecast) can compute variance across Plan vs. Commitment vs. Actual
// without any of the three being able to silently rewrite another.
//
// No Procurement Request entity: a Commitment can be created directly
// against a Supplier — nothing in this scope requires an intermediate
// request/RFQ step, so one was not built (avoids the RFQ/quote-comparison/
// bidding workflow explicitly deferred for this phase).
// =============================================================================

// --- Suppliers ---
// A company-wide directory, deliberately minimal (name/type/tax id/contact
// only) — not a CRM. type distinguishes a materials/equipment supplier from
// a labor subcontractor, since Commitment.type below needs to agree with
// which kind of party it's committing to.
export const supplierTypeEnum = pgEnum("supplier_type", ["supplier", "subcontractor"]);
export const supplierStatusEnum = pgEnum("supplier_status", ["active", "inactive"]);

export const suppliers = pgTable(
  "suppliers",
  {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  type: supplierTypeEnum("type").notNull(),
  taxId: text("tax_id"),
  email: text("email"),
  phone: text("phone"),
  address: text("address"),
  status: supplierStatusEnum("status").notNull().default("active"),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    // Slice Z — routes/suppliers.ts's list route filters by companyId.
    companyIdx: index("suppliers_company_idx").on(table.companyId),
  }),
);

// --- Commitments ---
// A Purchase Order or Subcontract — a binding commercial obligation to a
// Supplier. Deliberately NOT a peer of Contract (which represents revenue
// from the client); this is the outflow side.
//
// originalAmount / revisedAmount are DERIVED from commitment_lines, never
// independently editable — this is the explicit fix for the requirement
// "commitment.revisedAmount and line totals must never silently disagree."
// Both start NULL (a draft's total isn't meaningful until it has lines);
// originalAmount is frozen, once, at submit() from the sum of lines at
// that moment (never changes again — "what was originally committed").
// revisedAmount starts equal to it and moves only through amend(), which
// atomically recomputes it from the full current line set inside a
// FOR-UPDATE-locked transaction (see routes/commitments.ts) — the same
// principle as Contract's originalValue/revisedValue, but WITHOUT
// Contract's "amendment is a separate, unreconciled row" mechanic: that
// mechanic is exactly what the no-silent-disagreement requirement rules
// out here. The point-in-time history Contract gets from separate
// amendment rows, Commitment gets from its audit_events trail instead
// (every submit/approve/amend is its own audited before/after event) —
// no second audit or versioning mechanism was introduced for this.
export const commitmentTypeEnum = pgEnum("commitment_type", ["purchase_order", "subcontract"]);
// partially_fulfilled and closed are reserved for Phase 2B (Actual Cost /
// Progress linkage) — included now so the enum doesn't need a migration
// later, but no route in Phase 2A transitions a commitment into either.
export const commitmentStatusEnum = pgEnum("commitment_status", [
  "draft",
  "pending_approval",
  "active",
  "partially_fulfilled",
  "closed",
  "cancelled",
]);

export const commitments = pgTable(
  "commitments",
  {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  // Optional: a Commitment can exist without being tied to a specific
  // Contract (general project procurement), matching the nullable design
  // requested for Phase 2A.
  contractId: uuid("contract_id").references(() => contracts.id),
  supplierId: uuid("supplier_id")
    .notNull()
    .references(() => suppliers.id),
  type: commitmentTypeEnum("type").notNull(),
  status: commitmentStatusEnum("status").notNull().default("draft"),
  // Atomically claimed per company (same INSERT...SELECT MAX+1 discipline
  // as boqRevisions.revisionNumber / budgetRevisions.revisionNumber —
  // reused here rather than extending lib/numbering.ts's companies-column
  // mechanism, since that would need a new companies column/migration for
  // a per-company-wide sequence this pattern already gives for free).
  commitmentNumber: integer("commitment_number").notNull(),
  description: text("description"),
  originalAmount: numeric("original_amount", { precision: 14, scale: 2 }),
  revisedAmount: numeric("revised_amount", { precision: 14, scale: 2 }),
  // MIDAD Phase 2 — Subcontractor IPC foundation. The authoritative
  // retention percentage for THIS commitment — deliberately separate from
  // contracts.retentionPercent (that governs the owner/client contract's
  // own billing, a different financial direction entirely). Nullable:
  // most existing commitments predate this field and remain valid with no
  // retention withheld (0, not an error) until a value is set.
  retentionPercent: numeric("retention_percent", { precision: 5, scale: 2 }),
  currency: text("currency").notNull().default("SAR"),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  submittedAt: timestamp("submitted_at"),
  approvedBy: uuid("approved_by").references(() => users.id),
  approvedAt: timestamp("approved_at"),
  cancelledAt: timestamp("cancelled_at"),
  },
  (table) => ({
    // Slice Z — routes/commitments.ts's list route filters by projectId
    // alone.
    projectIdx: index("commitments_project_idx").on(table.projectId),
    // Phase 3.2 remediation (DB-001) — defense-in-depth backstop for the
    // per-company sequential numbering routes/commitments.ts already
    // claims atomically via a company-row-locked MAX+1 subquery.
    commitmentNumberUnique: uniqueIndex("commitments_company_number_unique").on(
      table.companyId,
      table.commitmentNumber,
    ),
  }),
);

// --- Commitment Lines ---
// companyId is carried directly here too (not only reachable via
// commitmentId -> commitments.companyId) per the Phase 2A tenant-isolation
// requirement that every new table have it, even where every existing
// analogous child table in this schema (boqItems, invoiceItems,
// quoteItems) does not.
export const commitmentLines = pgTable("commitment_lines", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  commitmentId: uuid("commitment_id")
    .notNull()
    .references(() => commitments.id, { onDelete: "cascade" }),
  costCodeId: uuid("cost_code_id").references(() => costCodes.id),
  boqItemId: uuid("boq_item_id").references(() => boqItems.id),
  description: text("description").notNull(),
  quantity: numeric("quantity", { precision: 14, scale: 3 }),
  rate: numeric("rate", { precision: 14, scale: 2 }),
  // Stored, computed once at write time via lib/money.ts when quantity and
  // rate are both given (roundMoney(quantity * rate)) — otherwise supplied
  // directly. Same frozen-computation discipline as boqItems.amount.
  amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const suppliersRelations = relations(suppliers, ({ one, many }) => ({
  company: one(companies, { fields: [suppliers.companyId], references: [companies.id] }),
  commitments: many(commitments),
}));

// --- Customers ---
// MIDAD Phase A' — the real product gap this closes: before this table,
// "who the client is" existed only as free-text (projects.clientName,
// invoices.clientName, quotes.clientName) with no unified profile and no
// way to see every project belonging to the same client. This table is
// deliberately minimal (name/contact/tax id only, same shape class as
// suppliers) — not a CRM, not a sales pipeline. clientName on
// projects/invoices/quotes is NEVER removed, NEVER auto-populated from
// this table, and NEVER required to match it — this is a purely additive
// entity a project MAY optionally link to (projects.customerId above).
// Explicitly out of scope for this slice: invoices/quotes linkage (left
// for a future, separately-scoped slice so this one stays small and
// leaves the tested Invoice/Quote routes untouched).
export const customerStatusEnum = pgEnum("customer_status", ["active", "inactive"]);

export const customers = pgTable(
  "customers",
  {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  contactName: text("contact_name"),
  taxId: text("tax_id"),
  email: text("email"),
  phone: text("phone"),
  address: text("address"),
  notes: text("notes"),
  status: customerStatusEnum("status").notNull().default("active"),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    // Slice Z — routes/customers.ts's list route filters by companyId.
    companyIdx: index("customers_company_idx").on(table.companyId),
  }),
);

export const customersRelations = relations(customers, ({ one, many }) => ({
  company: one(companies, { fields: [customers.companyId], references: [companies.id] }),
  projects: many(projects),
}));

export const commitmentsRelations = relations(commitments, ({ one, many }) => ({
  company: one(companies, { fields: [commitments.companyId], references: [companies.id] }),
  project: one(projects, { fields: [commitments.projectId], references: [projects.id] }),
  contract: one(contracts, { fields: [commitments.contractId], references: [contracts.id] }),
  supplier: one(suppliers, { fields: [commitments.supplierId], references: [suppliers.id] }),
  lines: many(commitmentLines),
}));

export const commitmentLinesRelations = relations(commitmentLines, ({ one }) => ({
  commitment: one(commitments, { fields: [commitmentLines.commitmentId], references: [commitments.id] }),
  costCode: one(costCodes, { fields: [commitmentLines.costCodeId], references: [costCodes.id] }),
  boqItem: one(boqItems, { fields: [commitmentLines.boqItemId], references: [boqItems.id] }),
}));

// =============================================================================
// MIDAD Phase 2B — Progress / Measurement.
//
// Measurement is EVIDENCE OF PHYSICAL PROGRESS against a specific published
// BOQ revision's quantities — not a financial instrument. It does not
// modify, and is not read by, Contract value, Cost Plan (budgetItems), BOQ
// values, Commitment amounts, or the legacy projects.budgetTotal. IPC
// (certification, valuation, retention, advance recovery) is explicitly a
// later phase; this table only tracks quantities and, for future IPC's
// convenience, a per-line value (measuredQuantity * the BOQ item's own
// rate) computed the same way boqItems.amount already is — not a second
// pricing/valuation engine, no tax, no retention, no advance applied here.
//
// Cumulative approved quantity is intentionally NOT a stored column: it is
// always derived as SUM(measurement_lines.measuredQuantity) across every
// line belonging to an APPROVED measurement for that boqItemId (see
// routes/measurements.ts's computeApprovedQuantity). Storing it would
// create a second, cache-able-but-driftable copy of a number that must
// never disagree with its own inputs — exactly the class of problem
// Phase 2A's Commitment amount was deliberately built to avoid.
// =============================================================================

export const measurementStatusEnum = pgEnum("measurement_status", ["draft", "submitted", "approved", "rejected"]);

export const measurements = pgTable(
  "measurements",
  {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  contractId: uuid("contract_id")
    .notNull()
    .references(() => contracts.id, { onDelete: "cascade" }),
  // The specific published revision this measurement was taken against —
  // set once at creation, never updated by any route, so a measurement's
  // reference stays correct even if a later revision supersedes this one.
  boqRevisionId: uuid("boq_revision_id")
    .notNull()
    .references(() => boqRevisions.id),
  status: measurementStatusEnum("status").notNull().default("draft"),
  measurementDate: date("measurement_date").notNull(),
  description: text("description"),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  submittedBy: uuid("submitted_by").references(() => users.id),
  submittedAt: timestamp("submitted_at"),
  approvedBy: uuid("approved_by").references(() => users.id),
  approvedAt: timestamp("approved_at"),
  rejectedBy: uuid("rejected_by").references(() => users.id),
  rejectedAt: timestamp("rejected_at"),
  rejectionReason: text("rejection_reason"),
  },
  (table) => ({
    // Slice Z — routes/measurements.ts's list route filters by projectId
    // alone.
    projectIdx: index("measurements_project_idx").on(table.projectId),
  }),
);

export const measurementLines = pgTable("measurement_lines", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  measurementId: uuid("measurement_id")
    .notNull()
    .references(() => measurements.id, { onDelete: "cascade" }),
  // Must belong to the SAME measurement.boqRevisionId — stricter than
  // Commitment lines' boqItemId check (which only requires "same
  // project"), because a BOQ item's quantity is only meaningful within
  // its own revision: a superseded revision's item may have had a
  // different quantity than the current one.
  boqItemId: uuid("boq_item_id")
    .notNull()
    .references(() => boqItems.id),
  measuredQuantity: numeric("measured_quantity", { precision: 14, scale: 3 }).notNull(),
  // Stored, computed once at write time (measuredQuantity * the BOQ
  // item's rate, via lib/money.ts) — same frozen-computation discipline
  // as boqItems.amount / commitmentLines.amount. Explicitly NOT a
  // valuation/certification figure (see the section comment above).
  value: numeric("value", { precision: 14, scale: 2 }),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const measurementsRelations = relations(measurements, ({ one, many }) => ({
  company: one(companies, { fields: [measurements.companyId], references: [companies.id] }),
  project: one(projects, { fields: [measurements.projectId], references: [projects.id] }),
  contract: one(contracts, { fields: [measurements.contractId], references: [contracts.id] }),
  boqRevision: one(boqRevisions, { fields: [measurements.boqRevisionId], references: [boqRevisions.id] }),
  lines: many(measurementLines),
}));

export const measurementLinesRelations = relations(measurementLines, ({ one }) => ({
  measurement: one(measurements, { fields: [measurementLines.measurementId], references: [measurements.id] }),
  boqItem: one(boqItems, { fields: [measurementLines.boqItemId], references: [boqItems.id] }),
}));

// =============================================================================
// MIDAD Phase 2C — IPC (Interim Payment Certificate).
//
// IPC answers "how much contractual value is being certified for payment
// this period" — a valuation/certification document, NOT a bank
// transaction, NOT an invoice, NOT an expense, NOT a Commitment, and NOT a
// replacement for Measurement (which only answers "how much physical work
// has been measured"). See docs/MIDAD_IPC_MODEL.md for the full model.
//
// Nothing here rewrites Contract value, BOQ value, Cost Plan, Commitment
// value, Expense value, or projects.budgetTotal — certify() only ever
// reads those tables. No invoice is auto-created on certification (that
// integration, if built later, references a certified IPC — it never
// happens automatically from here).
// =============================================================================

export const ipcStatusEnum = pgEnum("ipc_status", ["draft", "submitted", "approved", "certified", "rejected"]);

export const ipcs = pgTable(
  "ipcs",
  {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  contractId: uuid("contract_id")
    .notNull()
    .references(() => contracts.id, { onDelete: "cascade" }),
  boqRevisionId: uuid("boq_revision_id")
    .notNull()
    .references(() => boqRevisions.id),
  // Atomically claimed per CONTRACT (matching boqRevisions.revisionNumber's
  // scope, not commitments.commitmentNumber's company-wide scope) — an
  // IPC's number is meaningful as "the Nth certificate for THIS contract",
  // the standard construction-industry convention.
  ipcNumber: integer("ipc_number").notNull(),
  status: ipcStatusEnum("status").notNull().default("draft"),
  periodStart: date("period_start").notNull(),
  periodEnd: date("period_end").notNull(),
  notes: text("notes"),
  // Frozen once, atomically, at certify() — never independently editable,
  // never recomputed on read. All null/zero until then. See
  // docs/MIDAD_IPC_MODEL.md for the exact formula and why grossValue is
  // derived from ipc_lines rather than being a second, driftable number.
  grossValue: numeric("gross_value", { precision: 14, scale: 2 }),
  // Snapshotted from contract.retentionPercent AT CERTIFICATION TIME — a
  // later change to the contract's retention rule never rewrites an
  // already-certified IPC's retentionAmount.
  retentionAmount: numeric("retention_amount", { precision: 14, scale: 2 }),
  // Always 0 in Phase 2C. contracts.advancePercent alone is not a
  // sufficient recovery schedule (no advance-paid amount, no recovery
  // cap, no recovery period exists anywhere in this schema) — inventing
  // one here would be inventing a business rule this repository does not
  // establish. Reserved, not wired to any input, until a real advance
  // model exists.
  advanceRecoveryAmount: numeric("advance_recovery_amount", { precision: 14, scale: 2 }),
  // Always 0 in Phase 2C — reserved for a future explicit, auditable
  // deduction model; deliberately not a generic user-editable field (see
  // docs/MIDAD_IPC_MODEL.md).
  otherDeductions: numeric("other_deductions", { precision: 14, scale: 2 }),
  netCertified: numeric("net_certified", { precision: 14, scale: 2 }),
  currency: text("currency").notNull().default("SAR"),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  submittedBy: uuid("submitted_by").references(() => users.id),
  submittedAt: timestamp("submitted_at"),
  approvedBy: uuid("approved_by").references(() => users.id),
  approvedAt: timestamp("approved_at"),
  certifiedBy: uuid("certified_by").references(() => users.id),
  certifiedAt: timestamp("certified_at"),
  rejectedBy: uuid("rejected_by").references(() => users.id),
  rejectedAt: timestamp("rejected_at"),
  rejectionReason: text("rejection_reason"),
  },
  (table) => ({
    // Slice Z — routes/ipcs.ts's list route filters by projectId alone.
    projectIdx: index("ipcs_project_idx").on(table.projectId),
    // Phase 3.2 remediation (DB-001) — defense-in-depth backstop for the
    // per-contract sequential numbering routes/ipcs.ts already claims
    // atomically via a contract-row-locked MAX+1 subquery.
    ipcNumberUnique: uniqueIndex("ipcs_contract_number_unique").on(table.contractId, table.ipcNumber),
  }),
);

export const ipcLines = pgTable("ipc_lines", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  ipcId: uuid("ipc_id")
    .notNull()
    .references(() => ipcs.id, { onDelete: "cascade" }),
  // Must belong to the SAME ipc.boqRevisionId — same discipline as
  // measurement_lines.boqItemId. No direct measurementId FK: a line's
  // certifiable quantity may legitimately aggregate approved quantity
  // across MULTIPLE measurements for the same BOQ item, so the invariant
  // is enforced against that aggregate (see routes/ipcs.ts), not a single
  // measurement reference.
  boqItemId: uuid("boq_item_id")
    .notNull()
    .references(() => boqItems.id),
  description: text("description"),
  // Set once at line-add time (user input) — the quantity this line is
  // requesting to certify this period. Never changed afterward; a
  // correction means removing and re-adding the line (only possible
  // while the IPC is still draft/rejected).
  currentQuantity: numeric("current_quantity", { precision: 14, scale: 3 }).notNull(),
  // Frozen at line-add time from the BOQ item's own rate (same
  // "computed once at write time" discipline as boqItems.amount /
  // commitmentLines.amount / measurementLines.value) — BOQ items are
  // already immutable post-publish, so this is a defensive, self-
  // contained snapshot rather than a live join dependency.
  rate: numeric("rate", { precision: 14, scale: 2 }).notNull(),
  currentValue: numeric("current_value", { precision: 14, scale: 2 }).notNull(),
  // The next four fields are NULL until certify() — they are the
  // certification-time snapshot of the shared, race-checked quantity
  // ledger for this BOQ item (previousCertifiedQuantity/Value = what
  // prior CERTIFIED ipcs already claimed; cumulativeQuantity = previous +
  // this line's current), frozen atomically inside the same locked
  // transaction that flips ipcs.status to 'certified' — see
  // routes/ipcs.ts's certify handler and docs/MIDAD_IPC_MODEL.md.
  previousCertifiedQuantity: numeric("previous_certified_quantity", { precision: 14, scale: 3 }),
  previousCertifiedValue: numeric("previous_certified_value", { precision: 14, scale: 2 }),
  cumulativeQuantity: numeric("cumulative_quantity", { precision: 14, scale: 3 }),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const ipcsRelations = relations(ipcs, ({ one, many }) => ({
  company: one(companies, { fields: [ipcs.companyId], references: [companies.id] }),
  project: one(projects, { fields: [ipcs.projectId], references: [projects.id] }),
  contract: one(contracts, { fields: [ipcs.contractId], references: [contracts.id] }),
  boqRevision: one(boqRevisions, { fields: [ipcs.boqRevisionId], references: [boqRevisions.id] }),
  lines: many(ipcLines),
}));

export const ipcLinesRelations = relations(ipcLines, ({ one }) => ({
  ipc: one(ipcs, { fields: [ipcLines.ipcId], references: [ipcs.id] }),
  boqItem: one(boqItems, { fields: [ipcLines.boqItemId], references: [boqItems.id] }),
}));

// =============================================================================
// MIDAD Phase 2 — Subcontractor IPC.
//
// A payable certification instrument against a `commitments` row of
// `type = "subcontract"` — the payment-direction twin of Owner IPC's
// billing-direction certification, and NOT the same ledger. Owner IPC
// answers "how much am I billing the client, capped by measured/approved
// BOQ quantity"; Subcontractor IPC answers "how much do I owe this
// subcontractor, capped by what was actually committed to them." These
// two questions must never share a capacity pool, even when a commitment
// line happens to reference the same boqItemId an Owner IPC also bills
// against — see the Architecture Gate report for the full reasoning. No
// route in this domain reads ipcs/ipcLines, and no route in ipcs.ts reads
// this domain — enforced by construction (separate tables, separate
// ledger queries), not by convention alone.
//
// The commitment itself remains the single contractual ceiling (no
// parallel `subcontracts` table — see commitments.type = "subcontract").
// A commitment line may be either a quantity/rate line (ceiling =
// commitmentLine.quantity) or an amount-only line (ceiling =
// commitmentLine.amount, no quantity/rate exists to multiply) — both
// paths are modeled on subcontractIpcLines directly, never inferred.
// =============================================================================

export const subcontractIpcStatusEnum = pgEnum("subcontract_ipc_status", [
  "draft",
  "submitted",
  "approved",
  "certified",
  "rejected",
]);

export const subcontractIpcs = pgTable(
  "subcontract_ipcs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    commitmentId: uuid("commitment_id")
      .notNull()
      .references(() => commitments.id, { onDelete: "cascade" }),
    // Atomically claimed PER COMMITMENT (matching ipcs.ipcNumber's
    // per-contract scope, not commitments.commitmentNumber's company-wide
    // scope) — "the Nth certificate for THIS subcontract." Two different
    // commitments may both have IPC number 1.
    ipcNumber: integer("ipc_number").notNull(),
    status: subcontractIpcStatusEnum("status").notNull().default("draft"),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    notes: text("notes"),
    // Frozen once, atomically, at certify() — never independently
    // editable, never recomputed on read. All null until then.
    grossValue: numeric("gross_value", { precision: 14, scale: 2 }),
    // The retention PERCENTAGE actually used, read live from
    // commitments.retentionPercent at certify() and frozen here — a later
    // change to the commitment's retention rate never rewrites an
    // already-certified subcontractor IPC's snapshot.
    retentionPercent: numeric("retention_percent", { precision: 5, scale: 2 }),
    retentionAmount: numeric("retention_amount", { precision: 14, scale: 2 }),
    // Always 0 in this phase — no advance-recovery schedule/cap/period
    // exists anywhere in this schema for a subcontract, same deliberate
    // non-invention as ipcs.advanceRecoveryAmount.
    advanceRecoveryAmount: numeric("advance_recovery_amount", { precision: 14, scale: 2 }),
    // Always 0 in this phase — reserved, not wired to any input.
    otherDeductions: numeric("other_deductions", { precision: 14, scale: 2 }),
    netCertified: numeric("net_certified", { precision: 14, scale: 2 }),
    currency: text("currency").notNull().default("SAR"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    submittedBy: uuid("submitted_by").references(() => users.id),
    submittedAt: timestamp("submitted_at"),
    approvedBy: uuid("approved_by").references(() => users.id),
    approvedAt: timestamp("approved_at"),
    certifiedBy: uuid("certified_by").references(() => users.id),
    certifiedAt: timestamp("certified_at"),
    rejectedBy: uuid("rejected_by").references(() => users.id),
    rejectedAt: timestamp("rejected_at"),
    rejectionReason: text("rejection_reason"),
  },
  (table) => ({
    companyIdx: index("subcontract_ipcs_company_idx").on(table.companyId),
    projectIdx: index("subcontract_ipcs_project_idx").on(table.projectId),
    commitmentIdx: index("subcontract_ipcs_commitment_idx").on(table.commitmentId),
    statusIdx: index("subcontract_ipcs_status_idx").on(table.status),
    // Phase 3.2 remediation (DB-001) — defense-in-depth backstop for the
    // per-commitment sequential numbering routes/subcontractIpcs.ts
    // already claims atomically via a commitment-row-locked MAX+1
    // subquery.
    ipcNumberUnique: uniqueIndex("subcontract_ipcs_commitment_number_unique").on(
      table.commitmentId,
      table.ipcNumber,
    ),
  }),
);

export const subcontractIpcLines = pgTable(
  "subcontract_ipc_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    subcontractIpcId: uuid("subcontract_ipc_id")
      .notNull()
      .references(() => subcontractIpcs.id, { onDelete: "cascade" }),
    // Must belong to the SAME subcontractIpc.commitmentId — same
    // ownership discipline as ipcLines.boqItemId belonging to the same
    // ipc.boqRevisionId. This is the certifiable ceiling, never a BOQ
    // item directly (see the section comment above).
    commitmentLineId: uuid("commitment_line_id")
      .notNull()
      .references(() => commitmentLines.id),
    description: text("description"),
    // Quantity/rate path — set only when the referenced commitment line
    // itself carries a quantity+rate; NULL for an amount-only line. Set
    // once at line-add time, never changed afterward (a correction means
    // removing and re-adding the line while still draft/rejected).
    currentQuantity: numeric("current_quantity", { precision: 14, scale: 3 }),
    // Frozen from the commitment line's own rate at line-add time — NULL
    // for an amount-only line.
    rate: numeric("rate", { precision: 14, scale: 2 }),
    // Always set, regardless of path: quantity*rate (quantity/rate path,
    // server-computed) or the directly entered certification amount
    // (amount-only path, input — never derived from a fake quantity/rate).
    currentValue: numeric("current_value", { precision: 14, scale: 2 }).notNull(),
    // Certification-time snapshot of THIS COMMITMENT LINE's own
    // previously-certified / cumulative state — scoped strictly to
    // subcontract_ipc_lines joined to subcontract_ipcs.status='certified'
    // for this same commitmentLineId. Quantity fields are NULL for an
    // amount-only line (no quantity concept exists there); the value
    // fields are always populated after certify(), since currentValue
    // always exists on both paths.
    previousCertifiedQuantity: numeric("previous_certified_quantity", { precision: 14, scale: 3 }),
    cumulativeQuantity: numeric("cumulative_quantity", { precision: 14, scale: 3 }),
    previousCertifiedValue: numeric("previous_certified_value", { precision: 14, scale: 2 }),
    cumulativeValue: numeric("cumulative_value", { precision: 14, scale: 2 }),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("subcontract_ipc_lines_company_idx").on(table.companyId),
    ipcIdx: index("subcontract_ipc_lines_ipc_idx").on(table.subcontractIpcId),
    commitmentLineIdx: index("subcontract_ipc_lines_commitment_line_idx").on(table.commitmentLineId),
  }),
);

export const subcontractIpcsRelations = relations(subcontractIpcs, ({ one, many }) => ({
  company: one(companies, { fields: [subcontractIpcs.companyId], references: [companies.id] }),
  project: one(projects, { fields: [subcontractIpcs.projectId], references: [projects.id] }),
  commitment: one(commitments, { fields: [subcontractIpcs.commitmentId], references: [commitments.id] }),
  lines: many(subcontractIpcLines),
}));

export const subcontractIpcLinesRelations = relations(subcontractIpcLines, ({ one }) => ({
  subcontractIpc: one(subcontractIpcs, { fields: [subcontractIpcLines.subcontractIpcId], references: [subcontractIpcs.id] }),
  commitmentLine: one(commitmentLines, { fields: [subcontractIpcLines.commitmentLineId], references: [commitmentLines.id] }),
}));

// =============================================================================
// MIDAD Phase 2D — Forecast (ETC / EAC).
//
// Forecast is a DERIVED financial intelligence layer, not a new source of
// truth: it only ever READS Cost Plan (budgetItems.plannedAmount), Actual
// Cost (expenses.amount), Committed Cost (commitments/commitmentLines), and
// Certified Progress (certified ipcs), then computes a deterministic
// projection via lib/forecast.ts's pure calculateForecast(). It never
// writes to any of those tables, never reads or writes projects.budgetTotal,
// and never substitutes contracts.revisedValue for the Cost Plan. See
// docs/MIDAD_FORECAST_MODEL.md for the full model, including exactly which
// commitment states count, how the as-of-date cutoff works per source, and
// the documented double-counting / currency / Method-C limitations.
//
// A snapshot is an immutable historical record of one such calculation at
// one point in time — never independently editable, never recalculated
// in-place. No sequence number is generated (id + createdAt/asOfDate are
// sufficient identifiers), avoiding the race-safety question entirely
// rather than introducing an unnecessary MAX+1 numbering scheme.
// =============================================================================

export const forecastMethodEnum = pgEnum("forecast_method", ["cost_to_complete", "commitment_aware"]);

export interface ForecastSnapshotAssumptions {
  // Commitment ids excluded from committedCost because their currency did
  // not match the project's determined currency — see
  // docs/MIDAD_FORECAST_MODEL.md's Currency section. Never silently summed
  // across currencies; never silently dropped without a visible trail.
  excludedForeignCurrencyCommitmentIds: string[];
}

export const forecastSnapshots = pgTable("forecast_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  asOfDate: date("as_of_date").notNull(),
  method: forecastMethodEnum("method").notNull(),
  currency: text("currency").notNull(),
  // The four canonical inputs, frozen at calculation time — never
  // recomputed on read, never independently editable.
  costPlan: numeric("cost_plan", { precision: 14, scale: 2 }).notNull(),
  actualCost: numeric("actual_cost", { precision: 14, scale: 2 }).notNull(),
  committedCost: numeric("committed_cost", { precision: 14, scale: 2 }).notNull(),
  certifiedValue: numeric("certified_value", { precision: 14, scale: 2 }).notNull(),
  remainingCost: numeric("remaining_cost", { precision: 14, scale: 2 }).notNull(),
  etc: numeric("etc", { precision: 14, scale: 2 }).notNull(),
  eac: numeric("eac", { precision: 14, scale: 2 }).notNull(),
  variance: numeric("variance", { precision: 14, scale: 2 }).notNull(),
  // Nullable: undefined (not zero) when costPlan is 0 — see
  // lib/forecast.ts's calculateForecast for why.
  variancePercent: numeric("variance_percent", { precision: 9, scale: 2 }),
  assumptions: jsonb("assumptions").$type<ForecastSnapshotAssumptions>().notNull(),
  notes: text("notes"),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const forecastSnapshotsRelations = relations(forecastSnapshots, ({ one }) => ({
  company: one(companies, { fields: [forecastSnapshots.companyId], references: [companies.id] }),
  project: one(projects, { fields: [forecastSnapshots.projectId], references: [projects.id] }),
}));

// ============================================================================
// MIDAD Phase D1 — Platform Operator Foundation
// ============================================================================
// Deliberately placed last and deliberately isolated: this table has NO
// column referencing companies/users/projects/anything above it, and
// nothing above it references this table. That is the point — see the
// Phase D architectural decision report (approved by the Product Owner as
// Phase D1) for the full reasoning: every tenant table in this schema
// assumes a row belongs to exactly one company (companies.id is NOT NULL
// on every one of them), and the JWT payload every tenant route trusts is
// {userId, companyId}. A platform operator must NOT be pinned to a tenant
// at all, so it cannot safely be "a user with an elevated role" — it needs
// to be a genuinely separate identity, checked by a genuinely separate
// authentication path (lib/platformJwt.ts, middleware/platformAuth.ts),
// never touching req.userId/req.companyId or the "users"/"companies"
// tables' rows.
export const platformOperatorStatusEnum = pgEnum("platform_operator_status", ["active", "deactivated"]);
// Exactly one role for now, per Phase D1's explicit scope — deliberately
// not "platform_owner"/"support"/"operations": those remain unresolved
// Product Owner decisions (see the Phase D report), not something to
// pre-invent here just because an enum makes it easy to add values later.
export const platformOperatorRoleEnum = pgEnum("platform_operator_role", ["platform_operator"]);

export const platformOperators = pgTable("platform_operators", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name").notNull(),
  role: platformOperatorRoleEnum("role").notNull().default("platform_operator"),
  status: platformOperatorStatusEnum("status").notNull().default("active"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ============================================================================
// MIDAD Phase D2 — Platform Admin / Support Access
// ============================================================================
// A support session is an explicit, time-limited, revocable grant for ONE
// platform operator to read ONE tenant's data — never a standing
// capability. Deliberately its own DB row, not encoded into (or replacing)
// the platform JWT from D1: a JWT alone can't be revoked before its own
// expiry, and D2's whole premise is that access must be revocable
// immediately (middleware/requireSupportSession.ts re-checks this row from
// the database on every request it gates, the same discipline
// platformAuth/requireAuth already established for operator/user status).
// References ONLY platform_operators and companies — never users, never
// any tenant table's own columns; creating this table does not modify
// either of those tables' definitions.
export const supportSessions = pgTable("support_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  platformOperatorId: uuid("platform_operator_id")
    .notNull()
    .references(() => platformOperators.id),
  // Bound permanently at creation — no route anywhere lets this be
  // changed after the fact. This is the entire mechanism that prevents a
  // "companyId = *" wildcard: every read this session ever authorizes is
  // scoped to this one column's value, read from the database, never from
  // client input.
  targetCompanyId: uuid("target_company_id")
    .notNull()
    .references(() => companies.id),
  // Required, not optional: an unexplained support session is exactly the
  // kind of thing this table exists to make impossible.
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  expiresAt: timestamp("expires_at").notNull(),
  revokedAt: timestamp("revoked_at"),
});

// --- ZATCA e-invoicing — multi-tenant EGS/submission persistence (Slice 2) ---
// Every table below is tenant-scoped via companyId, the same discipline as
// every other table in this file. This slice is persistence-only: no route
// wires into these tables yet (that is a later, separately-gated slice),
// no FATOORA API call exists anywhere in the codebase, and no column here
// ever holds a real secret — secretRef is an opaque reference into a
// not-yet-built secret store. See server/src/lib/zatca/domain/ for the
// tenant-scoped read/write functions and docs/ZATCA_IMPLEMENTATION_STATUS.md
// for exactly what is and isn't implemented.
//
// ICV is a dedicated per-(company, EGS unit) counter — deliberately never
// companies.next_invoice_number, whose own gap risk (documented in the
// ZATCA discovery report: claimed before its enclosing invoice-creation
// transaction commits) would violate ZATCA's no-gap ICV requirement if
// reused. Nothing below reads or writes next_invoice_number.

export const zatcaEnvironmentEnum = pgEnum("zatca_environment", ["simulation", "production"]);

export const zatcaEgsStatusEnum = pgEnum("zatca_egs_status", [
  "not_onboarded",
  "onboarding",
  "active",
  "revoked",
  "deactivated",
]);

export const zatcaCsidStatusEnum = pgEnum("zatca_csid_status", [
  "none",
  "compliance_pending",
  "compliance_issued",
  "production_issued",
  "expired",
  "revoked",
]);

export const zatcaSubmissionStateEnum = pgEnum("zatca_submission_state", [
  "not_submitted",
  "ready_for_submission",
  "submitting",
  "submitted",
  "cleared",
  "reported",
  "rejected",
  "retry_required",
  "compliance_pending",
  "compliance_failed",
]);

// UBL/ZATCA document type codes: 388 = Tax Invoice (standard or
// simplified, distinguished by the `subtype` column below), 381 = Credit
// Note, 383 = Debit Note.
export const zatcaDocumentTypeEnum = pgEnum("zatca_document_type", ["388", "381", "383"]);

// One row per EGS (E-invoicing Generation Solution) unit a company has
// registered. secretRef must never hold an actual private key, CSID
// secret, or certificate material — see the file-level comment above.
export const zatcaEgsUnits = pgTable(
  "zatca_egs_units",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    environment: zatcaEnvironmentEnum("environment").notNull(),
    status: zatcaEgsStatusEnum("status").notNull().default("not_onboarded"),
    onboardingStatus: text("onboarding_status"),
    csidStatus: zatcaCsidStatusEnum("csid_status").notNull().default("none"),
    certificateExpiresAt: timestamp("certificate_expires_at"),
    secretRef: text("secret_ref"),
    // The PIH chain pointer for this EGS: the hash of the most recently
    // submitted document. Read/updated only under a row lock (SELECT ...
    // FOR UPDATE on this row) by a future submission function — this
    // slice adds no submission trigger anywhere, only the read/update-
    // under-lock primitive in domain/pih.ts.
    lastDocumentHash: text("last_document_hash"),
    lastCommunicationAt: timestamp("last_communication_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("zatca_egs_units_company_idx").on(table.companyId),
  }),
);

// One row per real CSR/key-pair generation event (Slice J — ZATCA CSR
// Instance persistence). An EGS unit legitimately accumulates MANY of
// these over its life (first onboarding, a regeneration after failed
// compliance, a renewal's fresh CSR, ...) — this table is deliberately
// insert-only/historical, never the current-state pointer. Current state
// ("where is this EGS right now") stays on zatca_egs_units's own
// status/csidStatus/certificateExpiresAt/secretRef columns, unchanged by
// this table's existence — see the file-level comment above and
// domain/csr.ts's own comment for how the two relate.
//
// purpose: deliberately a free-form NULLABLE text column, not an enum.
// The real ZATCA-side taxonomy for "was this onboarding, regeneration, or
// renewal" is not established from any verified source available to this
// project (see docs/zatca — Slices D through I's own architecture audits)
// — inventing enum values here would misrepresent an unverified MIDAD
// guess as settled ZATCA semantics. Left unset (NULL) until a real
// taxonomy is verified; the column exists so a future caller CAN record
// one without a schema change, but nothing in this slice writes to it.
//
// secretRef: the opaque ZatcaSecretStore reference for the key pair THIS
// CSR generation produced — never the credential material itself (same
// invariant as zatca_egs_units.secretRef). Deliberately NOT unique and
// deliberately never deleted by CSR regeneration (see domain/csr.ts) —
// the whole point of this table is that an earlier CSR's secretRef stays
// independently resolvable after a later CSR is generated.
export const zatcaCsrInstanceStatusEnum = pgEnum("zatca_csr_instance_status", ["generated", "superseded"]);

export const zatcaCsrInstances = pgTable(
  "zatca_csr_instances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    egsUnitId: uuid("egs_unit_id")
      .notNull()
      .references(() => zatcaEgsUnits.id, { onDelete: "cascade" }),
    // See file comment above — intentionally unconstrained, intentionally
    // unwritten by this slice.
    purpose: text("purpose"),
    // The exact 4-digit value supplied to generateCsrForEgsUnit's
    // fields.invoiceType, persisted verbatim — never reinterpreted,
    // never re-derived. See csr/csrBuilder.ts for the validation this
    // value already passed before reaching here (unchanged by this slice).
    invoiceType: text("invoice_type").notNull(),
    secretRef: text("secret_ref").notNull(),
    status: zatcaCsrInstanceStatusEnum("status").notNull().default("generated"),
    // Self-reference: set on THIS row once a later CSR generation for the
    // same EGS unit supersedes it. Nullable — most rows (the current one,
    // and any this slice never revisits) stay NULL indefinitely. Same
    // self-referencing-FK convention already used elsewhere in this file
    // (e.g. boqRevisions.supersedesRevisionId).
    supersededBy: uuid("superseded_by").references((): AnyPgColumn => zatcaCsrInstances.id),
    generatedAt: timestamp("generated_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    egsUnitIdx: index("zatca_csr_instances_egs_unit_idx").on(table.egsUnitId),
    companyIdx: index("zatca_csr_instances_company_idx").on(table.companyId),
  }),
);

// One row per successful Compliance CSID exchange for one specific CSR
// Instance (Slice L — ZATCA Compliance Lifecycle persistence). Cardinality
// is CSR Instance (1) -> Compliance Lifecycle (0..1): a CSR Instance may
// have none yet, but never more than one — enforced by the unique index
// below, not just application code. This table records ONLY that a
// Compliance CSID was requested and issued for this CSR — it deliberately
// does NOT claim compliance testing itself is complete (see
// domain/complianceCsid.ts's file comment): "Compliance CSID issued" and
// "all required Compliance Steps passed" are two different, unverified-
// vs-verified facts, and this table only ever records the former.
//
// status: a single-value enum ("issued") rather than a richer
// pending/issued/failed machine — deliberately, per this slice's own
// scope: a row is only ever inserted from domain/complianceCsid.ts AFTER
// the provider call has already succeeded (the provider throws a
// ZatcaError on any non-success FATOORA response — see
// provider/fatooraClient.ts's fatooraRequestComplianceCsid — so there is
// never a "pending" or "failed" in-database state to represent; nothing in
// this slice ever transitions this column after insert). The column
// exists (per the approved design) so a future, separately-verified state
// transition (e.g. a real revocation/supersession rule) can extend this
// enum without a new column — nothing here invents what that rule is.
//
// secretRef: the opaque ZatcaSecretStore reference for the Compliance CSID
// credential (binarySecurityToken + secret) this exchange produced —
// never the credential material itself, and a completely independent
// reference from the owning CSR Instance's own secretRef (see
// domain/complianceCsid.ts's file comment for why these two secrets must
// never be conflated: one is the CSR's key pair, the other is the
// certificate/secret ZATCA issued in exchange for it).
export const zatcaComplianceLifecycleStatusEnum = pgEnum("zatca_compliance_lifecycle_status", ["issued"]);

export const zatcaComplianceLifecycles = pgTable(
  "zatca_compliance_lifecycles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    csrInstanceId: uuid("csr_instance_id")
      .notNull()
      .references(() => zatcaCsrInstances.id, { onDelete: "cascade" }),
    // ZATCA's requestID, normalized to a string by the provider layer —
    // same String() convention as ZatcaComplianceCsidResult.requestId (see
    // provider/types.ts) — persisted verbatim, never re-derived.
    requestId: text("request_id").notNull(),
    dispositionMessage: text("disposition_message").notNull(),
    secretRef: text("secret_ref").notNull(),
    status: zatcaComplianceLifecycleStatusEnum("status").notNull().default("issued"),
    startedAt: timestamp("started_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    // Enforces the CSR Instance (1) -> Compliance Lifecycle (0..1)
    // cardinality at the database level, not just in application code.
    oneLifecyclePerCsrInstance: uniqueIndex("zatca_compliance_lifecycles_csr_instance_unique").on(table.csrInstanceId),
    companyIdx: index("zatca_compliance_lifecycles_company_idx").on(table.companyId),
  }),
);

// One row per real call to ZATCA's Compliance Invoice endpoint (POST
// /compliance/invoices) for one Compliance Lifecycle (Slice M — ZATCA
// Compliance Attempt persistence). Purely historical/insert-only, same as
// zatca_csr_instances: a Compliance Lifecycle legitimately accumulates
// many of these (one real ZATCA round trip each) and none of them are
// ever overwritten or deleted. No uniqueness constraint anywhere on this
// table — multiple attempts (including multiple attempts of the same
// documentType) are explicitly expected and allowed; see
// domain/complianceInvoice.ts's file comment for exactly when a row here
// is and is not created.
//
// documentType: reuses zatcaDocumentTypeEnum verbatim — the SAME already-
// established MIDAD-wide ZATCA document-type taxonomy zatca_submissions
// already persists as documentTypeCode ("388"/"381"/"383"), not a new,
// Compliance-Invoice-specific vocabulary. This is a deliberate choice,
// not a guess: no prior Compliance Invoice domain flow existed before
// this slice (confirmed by an audit of every call site — see
// domain/complianceInvoice.ts), so there was no prior "value already used
// by the Compliance Invoice flow" to inherit; reusing the one taxonomy
// this concept already has elsewhere in the schema, rather than inventing
// a second, Compliance-Invoice-only one (e.g. human-readable labels like
// "Tax Invoice"/"Simplified Invoice"), is the reading of "preserve the
// existing application taxonomy" this slice's spec calls for. Distinct
// from, and never derived from, the CSR Instance's own Functionality Map
// `invoiceType` string — see that column's own comment; this slice does
// not duplicate or derive from it.
//
// correlationId/rawStatus/normalizedOutcome: verbatim from
// ZatcaSubmissionResult (provider/types.ts) — correlationId and rawStatus
// are that type's own optional fields; normalizedOutcome is its `status`
// union ("cleared"/"reported"/"compliance_pending"/"rejected"), stored as
// plain text rather than a new pgEnum since only two of those four values
// (compliance_pending/rejected) are ever actually produced for THIS call
// by fatooraProvider.ts's normalizeComplianceInvoiceResponse — declaring
// an enum with two permanently-unreachable values here would misrepresent
// this column's real range. All three are nullable: null on the one path
// this slice ever leaves them null, see below.
//
// errorCategory: the existing ZatcaErrorCategory (lib/zatca/errors.ts)
// of a thrown ZatcaError, when the provider call itself failed outright
// (never reached/returned a recognized ZatcaSubmissionResult) — never a
// new error taxonomy. errorCode: reserved for a genuinely distinct
// ZATCA-native error code, per this slice's audit finding that no such
// concept exists anywhere in this codebase today (zatca_submissions'
// own zatcaErrorCode column is, in the one place it's ever written,
// literally the same string as its error's category — not a second,
// independent piece of information) — so this column stays unpopulated
// by this slice rather than duplicating errorCategory's value into it a
// second time under a different name. Both are null on a successful or
// ZATCA-rejected call (a real, non-throwing ZatcaSubmissionResult was
// produced) and populated only when the provider call threw.
//
// retryOfAttemptId: nullable self-reference (same convention as
// zatca_csr_instances.supersededBy) — exists per the approved schema, but
// nothing in this slice's domain flow ever populates it: no retry
// identity concept exists yet for Compliance Invoice calls (confirmed by
// this slice's own audit), and inventing one here would be exactly the
// kind of fabricated relationship this slice's spec forbids.
//
// invoiceFamily (Slice Q-Implementation): "standard" | "simplified" — which
// ZATCA compliance-test family this specific attempt targeted. Required
// because documentType alone cannot distinguish a Standard Tax Invoice
// attempt from a Simplified Tax Invoice attempt (both documentType "388")
// when the owning CSR Instance's Functionality Map is "1100" (both
// families supported) — confirmed as a real, unrecoverable historical-
// identity gap by the Slice Q audit (no other column, and no later
// derivation from the CSR, can reconstruct which family a "1100"-CSR
// attempt targeted). Caller-supplied at attempt-creation time (see
// domain/complianceInvoice.ts's CSR-compatibility validation), never
// derived from documentType/clientTaxId/the CSR's invoiceType/anything
// else, and never updated after insert — same immutable-history contract
// as every other column on this table.
//
// Plain text, not a new pgEnum — matches the one existing column in this
// schema with the identical two-value shape (zatca_submissions.subtype,
// via lib/zatca/types.ts's ZatcaInvoiceSubtype union), which is also plain
// text rather than a pgEnum. Despite sharing the same two string values,
// this column is DELIBERATELY INDEPENDENT from zatca_submissions.subtype:
// that column is a real-invoice business classification derived from
// invoices.clientTaxId (documentBuilder.ts), unrelated to any CSR's
// Functionality Map — the two concepts must never be conflated, and this
// column intentionally does not reuse that type or that derivation.
export const zatcaComplianceAttempts = pgTable(
  "zatca_compliance_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    complianceLifecycleId: uuid("compliance_lifecycle_id")
      .notNull()
      .references(() => zatcaComplianceLifecycles.id, { onDelete: "cascade" }),
    documentType: zatcaDocumentTypeEnum("document_type").notNull(),
    invoiceFamily: text("invoice_family").notNull(),
    correlationId: text("correlation_id"),
    rawStatus: text("raw_status"),
    normalizedOutcome: text("normalized_outcome"),
    attemptedAt: timestamp("attempted_at").notNull().defaultNow(),
    errorCategory: text("error_category"),
    errorCode: text("error_code"),
    retryOfAttemptId: uuid("retry_of_attempt_id").references((): AnyPgColumn => zatcaComplianceAttempts.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    lifecycleIdx: index("zatca_compliance_attempts_lifecycle_idx").on(table.complianceLifecycleId),
    companyIdx: index("zatca_compliance_attempts_company_idx").on(table.companyId),
  }),
);

// One row per real call to a still-unwired ZATCA provider operation —
// Production CSID Onboarding and Production CSID Renewal (Slice W).
// Deliberately NOT a "compliance steps" or completion model: this table
// records ONLY the technical fact that MIDAD made one specific provider
// call and what came back — never whether the taxpayer is compliant,
// whether onboarding/renewal is "complete", or any test count. See
// domain/productionCsid.ts's file comment for the full boundary this
// table exists inside.
//
// Deliberately separate from zatca_compliance_attempts (Slice M), which
// remains scoped to Compliance Invoice calls only — this table is not a
// generalization or replacement of it; neither existing table
// (zatca_compliance_lifecycles, zatca_compliance_attempts) is modified or
// retrofitted into this one, per this slice's explicit "preserve existing
// behavior" constraint.
//
// egsUnitId (not csrInstanceId/complianceLifecycleId): the one
// relationship both operation types below genuinely share. Onboarding
// conceptually belongs to the EGS unit receiving a Production CSID;
// Renewal's CSR is caller-supplied and opaque here (see
// domain/productionCsid.ts) and is not tied to any zatca_csr_instances
// row — forcing a CSR/Lifecycle FK onto Renewal would invent a
// relationship the verified provider contract does not establish.
export const zatcaProviderOperationTypeEnum = pgEnum("zatca_provider_operation_type", [
  "production_csid_onboarding",
  "production_csid_renewal",
]);

// Strictly technical/internal — never a ZATCA compliance verdict. Only
// two values exist because a row is only ever inserted once the provider
// call has genuinely concluded (mirrors zatca_compliance_attempts' own
// insert-only-on-conclusion convention — see domain/providerOperations.ts):
// "response_received" for any real, non-throwing provider response
// (including Renewal's verified "not_compliant" outcome — ZATCA responded,
// it just declined; this is a received response, not a technical failure)
// and "failed" for a thrown ZatcaError (the call itself did not complete).
// Values like "not_started"/"in_progress"/"submitted"/"blocked" are
// deliberately not included: nothing in this slice's domain flow ever
// creates a row before the call concludes, so they would be unused,
// speculative states.
export const zatcaProviderOperationStatusEnum = pgEnum("zatca_provider_operation_status", [
  "response_received",
  "failed",
]);

export const zatcaProviderOperations = pgTable(
  "zatca_provider_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    egsUnitId: uuid("egs_unit_id")
      .notNull()
      .references(() => zatcaEgsUnits.id, { onDelete: "cascade" }),
    operationType: zatcaProviderOperationTypeEnum("operation_type").notNull(),
    internalStatus: zatcaProviderOperationStatusEnum("internal_status").notNull(),
    // ZATCA's own requestID for this call, when one was returned —
    // verbatim, an opaque identifier, never arithmetic (same convention as
    // zatca_compliance_lifecycles.requestId).
    providerRequestId: text("provider_request_id"),
    dispositionMessage: text("disposition_message"),
    // The provider's own verified outcome discriminant, stored verbatim,
    // when the operation has one (Renewal's "issued"/"not_compliant" —
    // ZATCA's own vocabulary, never a MIDAD interpretation of it). Null
    // for operation types with no such discriminant (Onboarding).
    providerOutcome: text("provider_outcome"),
    // Opaque ZatcaSecretStore reference for the credential this operation
    // produced, if any — never the credential material itself. Completely
    // independent from every other secretRef in this schema (CSR
    // Instance's, Compliance Lifecycle's) — see domain/productionCsid.ts.
    secretRef: text("secret_ref"),
    // The thrown ZatcaError's own category — see
    // zatca_compliance_attempts.errorCategory's identical convention.
    // Null on a real (even "not_compliant") response.
    errorCategory: text("error_category"),
    startedAt: timestamp("started_at").notNull(),
    finishedAt: timestamp("finished_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    egsUnitIdx: index("zatca_provider_operations_egs_unit_idx").on(table.egsUnitId),
    companyIdx: index("zatca_provider_operations_company_idx").on(table.companyId),
  }),
);

// A dedicated ICV (Invoice Counter Value) per (company, EGS unit) — see
// the file-level comment for why this is never companies.next_invoice_number.
export const zatcaIcvCounters = pgTable(
  "zatca_icv_counters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    egsUnitId: uuid("egs_unit_id")
      .notNull()
      .references(() => zatcaEgsUnits.id, { onDelete: "cascade" }),
    value: integer("value").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    oneCounterPerEgs: uniqueIndex("zatca_icv_counters_company_egs_unique").on(table.companyId, table.egsUnitId),
  }),
);

// The full lifecycle record of one ZATCA submission attempt. Exactly one
// of invoiceId/creditNoteId/debitNoteId may be populated — enforced by a
// real DB CHECK constraint, not just application code, since this is a
// genuine data-integrity invariant. creditNoteId/debitNoteId have no FK
// yet (those tables don't exist until a later slice) — plain nullable
// uuid columns for now.
export const zatcaSubmissions = pgTable(
  "zatca_submissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    egsUnitId: uuid("egs_unit_id")
      .notNull()
      .references(() => zatcaEgsUnits.id, { onDelete: "cascade" }),
    invoiceId: uuid("invoice_id").references(() => invoices.id, { onDelete: "cascade" }),
    creditNoteId: uuid("credit_note_id"),
    debitNoteId: uuid("debit_note_id"),
    documentTypeCode: zatcaDocumentTypeEnum("document_type_code").notNull(),
    subtype: text("subtype").notNull(),
    zatcaUuid: uuid("uuid").notNull().unique(),
    icv: integer("icv").notNull(),
    pih: text("pih").notNull(),
    documentHash: text("document_hash").notNull(),
    environment: zatcaEnvironmentEnum("environment").notNull(),
    state: zatcaSubmissionStateEnum("state").notNull().default("not_submitted"),
    zatcaStatus: text("zatca_status"),
    zatcaErrorCode: text("zatca_error_code"),
    zatcaErrorMessage: text("zatca_error_message"),
    warnings: jsonb("warnings"),
    requestId: text("request_id"),
    correlationId: text("correlation_id"),
    // Slice AB — the ZATCA-signed/stamped invoice XML (base64), returned
    // only on a genuine "CLEARED" clearInvoice response (see
    // provider/types.ts's ZatcaSubmissionResult.clearedInvoiceXmlBase64) —
    // never fabricated, never populated for any other outcome. This is the
    // tenant's actual legal cleared document; kept on the submission row
    // (never written to audit_events, which stays free of large blobs) so
    // GET /api/zatca/submissions/:id can return it.
    clearedDocumentXmlBase64: text("cleared_document_xml_base64"),
    retryCount: integer("retry_count").notNull().default(0),
    submittedAt: timestamp("submitted_at"),
    respondedAt: timestamp("responded_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("zatca_submissions_company_idx").on(table.companyId),
    egsUnitIdx: index("zatca_submissions_egs_unit_idx").on(table.egsUnitId),
    invoiceIdx: index("zatca_submissions_invoice_idx").on(table.invoiceId),
    // Slice 5 — closes a real concurrency gap found while testing: the
    // application-level "does a submission already exist for this
    // (company, EGS unit, invoice)?" check in domain/submissions.ts's
    // findSubmissionForInvoice() is a check-then-act race under genuine
    // concurrent requests (two parallel /prepare calls can both pass the
    // check before either has inserted its row). Postgres NULLs are never
    // equal to each other in a unique index, so this only constrains rows
    // that actually reference an invoice — credit/debit-note rows
    // (invoice_id NULL) are unaffected and unlimited, matching the
    // exactly-one-document-reference check below.
    oneSubmissionPerInvoicePerEgsUnit: uniqueIndex("zatca_submissions_egs_unit_invoice_unique").on(
      table.companyId,
      table.egsUnitId,
      table.invoiceId,
    ),
    exactlyOneDocumentReference: check(
      "zatca_submissions_exactly_one_document_reference",
      sql`(
        (CASE WHEN ${table.invoiceId} IS NOT NULL THEN 1 ELSE 0 END) +
        (CASE WHEN ${table.creditNoteId} IS NOT NULL THEN 1 ELSE 0 END) +
        (CASE WHEN ${table.debitNoteId} IS NOT NULL THEN 1 ELSE 0 END)
      ) = 1`,
    ),
  }),
);

// =============================================================================
// MIDAD Phase A — Mudad/WPS + Project Labor Cost (Slice A1: schema foundation)
//
// Per the approved architecture (Phase A discovery report): labor cost
// must become part of MIDAD's EXISTING Actual Cost / Forecast / Cash Flow
// pipeline, never a second, parallel accounting system. The only change
// to the existing financial model is expenses.costCodeId (added above,
// additive/nullable) — every table below is genuinely new, because no
// existing entity represents an individual worker, a payroll period, a
// WPS record, or a labor-to-project allocation (confirmed absent
// anywhere in this schema by that discovery pass).
//
// Employee vs. User — load-bearing, not cosmetic: `users` is MIDAD's own
// login/authentication identity (owner/member role). `employees` below is
// workforce identity — a person MIDAD tracks payroll cost for, who very
// often has no MIDAD login at all. employees.userId is nullable and
// OPTIONAL, linking a specific worker to a login only when that worker
// also happens to be a MIDAD user; it is never auto-populated, and a
// MIDAD user account never implies an employee record or vice versa.
//
// This slice is schema-only: no routes, no UI, nothing yet writes to any
// table below (A2+ adds that). Tables are declared before their relations
// blocks, all together, to avoid any forward-reference ordering issue —
// costCodes/files/projects/companies/users are already declared earlier
// in this file, so only genuinely-later references (payrollImportBatches
// from payrollRecords; the payrollImportRows/payrollRecords cross-link;
// laborCostPostings' own self-reference) use the lazy AnyPgColumn pattern
// already established elsewhere in this file (see budgetItems.costCodeId).
// =============================================================================

export const employeeStatusEnum = pgEnum("employee_status", ["active", "inactive"]);

// Deliberately minimal (data-minimization, per the discovery report) — no
// attendance/biometric/HR fields, no Nitaqat/GOSI categorization (a
// separate, later roadmap item). nationality/bank fields are optional and
// exist only because WPS itself requires salary paid into a compliant
// Saudi bank account — MIDAD only ever stores a reference, it never
// moves money or validates bank details.
export const employees = pgTable(
  "employees",
  {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  // Optional: set only if this specific worker also has a MIDAD login —
  // never assumed, never auto-created. See this section's own header
  // comment for why this must stay a separate concept from `users`.
  userId: uuid("user_id").references(() => users.id),
  employeeNumber: text("employee_number").notNull(),
  name: text("name").notNull(),
  status: employeeStatusEnum("status").notNull().default("active"),
  nationality: text("nationality"),
  bankName: text("bank_name"),
  iban: text("iban"),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("employees_company_idx").on(table.companyId),
    employeeNumberUnique: uniqueIndex("employees_company_number_unique").on(
      table.companyId,
      table.employeeNumber,
    ),
  }),
);

// --- Payroll Period ---
// Modeled directly on ipcs/subcontractIpcs' own periodStart/periodEnd +
// status-lifecycle pattern (draft/submitted/approved/certified/rejected)
// — "certified" renamed to "posted" here since that's the point a
// payroll period actually becomes financial truth (creates expenses rows
// via laborCostPostings).
export const payrollPeriodStatusEnum = pgEnum("payroll_period_status", [
  "draft",
  "submitted",
  "approved",
  "posted",
  "rejected",
]);

export const payrollPeriods = pgTable(
  "payroll_periods",
  {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  periodStart: date("period_start").notNull(),
  periodEnd: date("period_end").notNull(),
  payrollDate: date("payroll_date"),
  status: payrollPeriodStatusEnum("status").notNull().default("draft"),
  notes: text("notes"),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  submittedBy: uuid("submitted_by").references(() => users.id),
  submittedAt: timestamp("submitted_at"),
  approvedBy: uuid("approved_by").references(() => users.id),
  approvedAt: timestamp("approved_at"),
  postedBy: uuid("posted_by").references(() => users.id),
  postedAt: timestamp("posted_at"),
  rejectedBy: uuid("rejected_by").references(() => users.id),
  rejectedAt: timestamp("rejected_at"),
  rejectionReason: text("rejection_reason"),
  },
  (table) => ({
    companyIdx: index("payroll_periods_company_idx").on(table.companyId),
    // Duplicate-period DB backstop, matching the defense-in-depth
    // precedent every other numbered/period-scoped table in this schema
    // already carries (commitments_company_number_unique,
    // ipcs_contract_number_unique, etc.).
    periodUnique: uniqueIndex("payroll_periods_company_period_unique").on(
      table.companyId,
      table.periodStart,
      table.periodEnd,
    ),
  }),
);

// --- WPS Record (Payroll Record) ---
// One row per employee per payroll period. sourceType/provider/
// externalReference/verificationStatus are the provenance fields the
// approved architecture requires to distinguish INTERNAL data (manual
// entry, CSV/Excel import — buildable now) from OFFICIAL EXTERNAL data (a
// real Mudad/WPS provider integration — NOT VERIFIED to exist, NOT
// implemented, reserved for a future slice). verificationStatus defaults
// to "unverified"; nothing in this slice ever sets it "verified" — only a
// real future provider adapter would ever have grounds to.
export const payrollRecordSourceTypeEnum = pgEnum("payroll_record_source_type", [
  "manual",
  "csv_import",
  "excel_import",
  "external_provider",
]);
export const payrollVerificationStatusEnum = pgEnum("payroll_verification_status", [
  "unverified",
  "verified",
]);

export const payrollRecords = pgTable(
  "payroll_records",
  {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  payrollPeriodId: uuid("payroll_period_id")
    .notNull()
    .references(() => payrollPeriods.id, { onDelete: "cascade" }),
  employeeId: uuid("employee_id")
    .notNull()
    .references(() => employees.id),
  grossAmount: numeric("gross_amount", { precision: 12, scale: 2 }).notNull(),
  deductionsAmount: numeric("deductions_amount", { precision: 12, scale: 2 }).notNull().default("0"),
  netAmount: numeric("net_amount", { precision: 12, scale: 2 }).notNull(),
  sourceType: payrollRecordSourceTypeEnum("source_type").notNull().default("manual"),
  provider: text("provider"),
  externalReference: text("external_reference"),
  verificationStatus: payrollVerificationStatusEnum("verification_status").notNull().default("unverified"),
  // Forward reference: payrollImportBatches is declared further down this
  // file (it also references payrollRecords via `many()` in its own
  // relations block) — same lazy-callback pattern budgetItems.costCodeId
  // already uses for the same reason.
  importBatchId: uuid("import_batch_id").references((): AnyPgColumn => payrollImportBatches.id),
  importedAt: timestamp("imported_at"),
  verifiedAt: timestamp("verified_at"),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("payroll_records_company_idx").on(table.companyId),
    periodIdx: index("payroll_records_period_idx").on(table.payrollPeriodId),
    // One record per employee per period — DB-enforced, same discipline
    // as payroll_periods_company_period_unique above.
    employeePeriodUnique: uniqueIndex("payroll_records_period_employee_unique").on(
      table.payrollPeriodId,
      table.employeeId,
    ),
  }),
);

// --- Labor Allocation ---
// Employee -> Payroll Record -> Labor Allocation -> Project [-> Cost
// Code] -> Actual Cost. Mirrors commitmentLines' own "quantity*rate OR a
// direct amount, resolved server-side" discipline: percentage is the
// authoring input, amount is the frozen, resolved SAR figure a later
// slice's posting route uses — never recomputed from percentage at read
// time. The "never exceed 100%" invariant is enforced by a later slice's
// route logic (lock the parent payrollRecords row FOR UPDATE, recompute
// the full set from inside that transaction, exactly like
// commitments.ts's amend() already does) — not by a DB CHECK constraint,
// since Postgres cannot CHECK a cross-row aggregate.
export const laborAllocations = pgTable(
  "labor_allocations",
  {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  payrollRecordId: uuid("payroll_record_id")
    .notNull()
    .references(() => payrollRecords.id, { onDelete: "cascade" }),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  costCodeId: uuid("cost_code_id").references(() => costCodes.id),
  percentage: numeric("percentage", { precision: 5, scale: 2 }),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  notes: text("notes"),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("labor_allocations_company_idx").on(table.companyId),
    recordIdx: index("labor_allocations_record_idx").on(table.payrollRecordId),
    projectIdx: index("labor_allocations_project_idx").on(table.projectId),
  }),
);

// --- Labor Cost Posting ---
// The thin link between a Labor Allocation and the `expenses` row its
// financial posting actually created — this is what lets labor cost enter
// Actual Cost/Forecast/Cash Flow through the EXISTING pipeline with zero
// changes to collectForecastInputs/calculateForecast/calculateCashFlow
// (they only ever SUM(expenses.amount); this table is provenance, not a
// second actual-cost source). A reversal never edits or deletes the
// original expenses row: it inserts a NEW negative-amount expenses row
// plus a NEW laborCostPostings row with kind="reversal" pointing back at
// the posting it reverses — the same "amend by adding, never by
// overwriting" discipline commitments.ts's amend() already uses for its
// own financial history. No route in this slice writes here yet (A5).
//
// Known follow-up for the slice that starts writing here: expenses has an
// existing DELETE route (routes/budget.ts) with no knowledge of this
// table; expenseId below has no onDelete action (defaults to Postgres
// "no action"/restrict), so attempting to delete a labor-posted expense
// through that legacy route will correctly fail at the DB level rather
// than silently orphaning a posting — but it will surface as a raw
// constraint-violation error until that route is taught to recognize and
// reject this case with a clean message. Not fixed here since no code
// path can create such a row yet.
export const laborCostPostingKindEnum = pgEnum("labor_cost_posting_kind", ["posting", "reversal"]);

export const laborCostPostings = pgTable(
  "labor_cost_postings",
  {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  payrollPeriodId: uuid("payroll_period_id")
    .notNull()
    .references(() => payrollPeriods.id, { onDelete: "cascade" }),
  laborAllocationId: uuid("labor_allocation_id")
    .notNull()
    .references(() => laborAllocations.id, { onDelete: "cascade" }),
  expenseId: uuid("expense_id")
    .notNull()
    .references(() => expenses.id),
  kind: laborCostPostingKindEnum("kind").notNull().default("posting"),
  reversalOfPostingId: uuid("reversal_of_posting_id").references((): AnyPgColumn => laborCostPostings.id),
  postedBy: uuid("posted_by")
    .notNull()
    .references(() => users.id),
  postedAt: timestamp("posted_at").notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("labor_cost_postings_company_idx").on(table.companyId),
    periodIdx: index("labor_cost_postings_period_idx").on(table.payrollPeriodId),
    allocationIdx: index("labor_cost_postings_allocation_idx").on(table.laborAllocationId),
  }),
);

// --- Payroll Import (CSV/Excel) ---
// UPLOADED -> PARSING -> VALIDATED -> READY -> IMPORTED (or FAILED).
// fileId reuses the existing generic `files` table (entityType/entityId
// pattern — no schema change needed there) for the underlying uploaded
// bytes; files.checksum is reused for "was this exact file already
// uploaded for this period" duplicate-batch detection, so no checksum is
// duplicated here. payrollImportRows stages parsed rows with per-row
// validation errors BEFORE anything becomes a real payrollRecords row —
// committing a batch is an explicit, separate action a later slice adds
// (never implicit on upload).
export const payrollImportBatchStatusEnum = pgEnum("payroll_import_batch_status", [
  "uploaded",
  "parsing",
  "validated",
  "ready",
  "imported",
  "failed",
]);
export const payrollImportRowStatusEnum = pgEnum("payroll_import_row_status", [
  "pending",
  "valid",
  "invalid",
  "imported",
]);

export const payrollImportBatches = pgTable(
  "payroll_import_batches",
  {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  payrollPeriodId: uuid("payroll_period_id")
    .notNull()
    .references(() => payrollPeriods.id, { onDelete: "cascade" }),
  fileId: uuid("file_id")
    .notNull()
    .references(() => files.id),
  status: payrollImportBatchStatusEnum("status").notNull().default("uploaded"),
  rowCount: integer("row_count"),
  validRowCount: integer("valid_row_count"),
  errorRowCount: integer("error_row_count"),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  committedBy: uuid("committed_by").references(() => users.id),
  committedAt: timestamp("committed_at"),
  },
  (table) => ({
    companyIdx: index("payroll_import_batches_company_idx").on(table.companyId),
    periodIdx: index("payroll_import_batches_period_idx").on(table.payrollPeriodId),
  }),
);

export const payrollImportRows = pgTable(
  "payroll_import_rows",
  {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  importBatchId: uuid("import_batch_id")
    .notNull()
    .references(() => payrollImportBatches.id, { onDelete: "cascade" }),
  rowNumber: integer("row_number").notNull(),
  rawData: jsonb("raw_data").notNull(),
  parsedEmployeeNumber: text("parsed_employee_number"),
  parsedAmount: numeric("parsed_amount", { precision: 12, scale: 2 }),
  validationErrors: jsonb("validation_errors"),
  status: payrollImportRowStatusEnum("status").notNull().default("pending"),
  resultingPayrollRecordId: uuid("resulting_payroll_record_id").references(() => payrollRecords.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    batchIdx: index("payroll_import_rows_batch_idx").on(table.importBatchId),
  }),
);

// --- Phase A relations (all together, after every table above is
// declared, to avoid any forward-reference ordering issue) ---

export const employeesRelations = relations(employees, ({ one, many }) => ({
  company: one(companies, { fields: [employees.companyId], references: [companies.id] }),
  user: one(users, { fields: [employees.userId], references: [users.id] }),
  payrollRecords: many(payrollRecords),
}));

export const payrollPeriodsRelations = relations(payrollPeriods, ({ one, many }) => ({
  company: one(companies, { fields: [payrollPeriods.companyId], references: [companies.id] }),
  records: many(payrollRecords),
  importBatches: many(payrollImportBatches),
}));

export const payrollRecordsRelations = relations(payrollRecords, ({ one, many }) => ({
  company: one(companies, { fields: [payrollRecords.companyId], references: [companies.id] }),
  payrollPeriod: one(payrollPeriods, { fields: [payrollRecords.payrollPeriodId], references: [payrollPeriods.id] }),
  employee: one(employees, { fields: [payrollRecords.employeeId], references: [employees.id] }),
  importBatch: one(payrollImportBatches, { fields: [payrollRecords.importBatchId], references: [payrollImportBatches.id] }),
  allocations: many(laborAllocations),
}));

export const laborAllocationsRelations = relations(laborAllocations, ({ one, many }) => ({
  company: one(companies, { fields: [laborAllocations.companyId], references: [companies.id] }),
  payrollRecord: one(payrollRecords, { fields: [laborAllocations.payrollRecordId], references: [payrollRecords.id] }),
  project: one(projects, { fields: [laborAllocations.projectId], references: [projects.id] }),
  costCode: one(costCodes, { fields: [laborAllocations.costCodeId], references: [costCodes.id] }),
  postings: many(laborCostPostings),
}));

export const laborCostPostingsRelations = relations(laborCostPostings, ({ one }) => ({
  company: one(companies, { fields: [laborCostPostings.companyId], references: [companies.id] }),
  payrollPeriod: one(payrollPeriods, { fields: [laborCostPostings.payrollPeriodId], references: [payrollPeriods.id] }),
  laborAllocation: one(laborAllocations, { fields: [laborCostPostings.laborAllocationId], references: [laborAllocations.id] }),
  expense: one(expenses, { fields: [laborCostPostings.expenseId], references: [expenses.id] }),
  reversalOfPosting: one(laborCostPostings, { fields: [laborCostPostings.reversalOfPostingId], references: [laborCostPostings.id] }),
}));

export const payrollImportBatchesRelations = relations(payrollImportBatches, ({ one, many }) => ({
  company: one(companies, { fields: [payrollImportBatches.companyId], references: [companies.id] }),
  payrollPeriod: one(payrollPeriods, { fields: [payrollImportBatches.payrollPeriodId], references: [payrollPeriods.id] }),
  file: one(files, { fields: [payrollImportBatches.fileId], references: [files.id] }),
  rows: many(payrollImportRows),
  records: many(payrollRecords),
}));

export const payrollImportRowsRelations = relations(payrollImportRows, ({ one }) => ({
  importBatch: one(payrollImportBatches, { fields: [payrollImportRows.importBatchId], references: [payrollImportBatches.id] }),
  resultingPayrollRecord: one(payrollRecords, { fields: [payrollImportRows.resultingPayrollRecordId], references: [payrollRecords.id] }),
}));
