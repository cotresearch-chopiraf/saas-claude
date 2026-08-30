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

export const projects = pgTable("projects", {
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
});

// This table's plannedAmount is the canonical Cost Plan / expected-cost
// baseline for this product — the number future Commitment, Actual Cost,
// and Forecast logic computes variance against, grouped by project, cost
// code, BOQ item, and/or budget revision. It is NOT the same figure as
// Contract value (contracts.revisedValue — contractual/revenue value) or
// published BOQ value (Σ boqItems.amount — contractual scope valuation);
// see docs/MIDAD_FINANCIAL_MODEL.md for why these three are kept distinct
// rather than collapsed into one generic "budget" number.
export const budgetItems = pgTable("budget_items", {
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
});

export const expenses = pgTable("expenses", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  budgetItemId: uuid("budget_item_id").references(() => budgetItems.id, {
    onDelete: "set null",
  }),
  description: text("description").notNull(),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  expenseDate: date("expense_date").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const tasks = pgTable("tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  assigneeName: text("assignee_name"),
  dueDate: date("due_date"),
  status: taskStatusEnum("status").notNull().default("todo"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Renovation scope changes constantly — this is the #1 workflow gap this
// product exists to close. Approving a change order shifts the project's
// LEGACY budgetTotal by amountDelta (see the route handler) — this is the
// one sanctioned writer of that field, kept exactly as it was; it does not
// touch Contract, BOQ, or BudgetItems (see docs/MIDAD_FINANCIAL_MODEL.md).
export const changeOrders = pgTable("change_orders", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description"),
  amountDelta: numeric("amount_delta", { precision: 12, scale: 2 }).notNull(),
  status: changeOrderStatusEnum("status").notNull().default("pending"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// The single most-cited strength of the market leader (Buildertrend) is its
// site activity / daily log feature — this is the lightweight MVP version.
export const dailyLogs = pgTable("daily_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  note: text("note").notNull(),
  logDate: date("log_date").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

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
export const companyInvites = pgTable("company_invites", {
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
});

// A quote precedes a project — it's the estimate a contractor sends before
// work (and money) starts. publicToken lets the client view/accept it
// without an account, which is the whole point of a client-facing quote.
export const quotes = pgTable("quotes", {
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
});

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
export const invoices = pgTable("invoices", {
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
});

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

export const costCodes = pgTable("cost_codes", {
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
});

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

export const contracts = pgTable("contracts", {
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
});

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

export const boqRevisions = pgTable("boq_revisions", {
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
});

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

export const budgetRevisions = pgTable("budget_revisions", {
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
});

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
export const auditEvents = pgTable("audit_events", {
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
});

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
export const storageProviderEnum = pgEnum("storage_provider", ["local"]);

export const files = pgTable("files", {
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
});

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

export const suppliers = pgTable("suppliers", {
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
});

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

export const commitments = pgTable("commitments", {
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
});

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

export const customers = pgTable("customers", {
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
});

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

export const measurements = pgTable("measurements", {
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
});

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

export const ipcs = pgTable("ipcs", {
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
});

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
