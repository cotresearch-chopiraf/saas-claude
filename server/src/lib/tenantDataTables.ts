// MIDAD Final Pre-Launch audit, Phase 10-11 — Tenant Export / Import. The
// single source of truth both lib/tenantExport.ts and lib/tenantImport.ts
// read from, so the two can never drift out of sync with each other.
//
// This exact table order and dependency graph was computed mechanically
// from db/schema.ts's own `.references(() => X...)` declarations (not
// hand-traced), then verified to contain no cycles — every table appears
// after every other table it has a NOT NULL or nullable foreign key to,
// so inserting rows in this order during import never violates a
// foreign-key constraint. "companies" itself is handled separately by
// lib/tenantImport.ts (inserted first, before this list).
//
// Deliberately excluded from export/import entirely: password_reset_tokens,
// client_portal_sessions, idempotency_keys, user_sessions, support_sessions
// (security tokens / purely internal operational state — never part of a
// tenant's own business data, and re-importing a stale session/token row
// would be actively wrong, not just unnecessary), and every platform-level
// table (platform_operators, platform_operator_sessions, plans,
// feature_flags, compliance_rule_versions — platform-owned, not
// tenant-owned).
export const TENANT_EXCLUDED_TABLES = [
  "password_reset_tokens",
  "client_portal_sessions",
  "idempotency_keys",
  "user_sessions",
  "support_sessions",
  "platform_operators",
  "platform_operator_sessions",
  "plans",
  "feature_flags",
  "compliance_rule_versions",
] as const;

// Tables with their own direct company_id column — filtered with a plain
// `WHERE company_id = $1`.
export const TENANT_DIRECT_TABLES = [
  "users",
  "audit_events",
  "customers",
  "projects",
  "cost_codes",
  "contracts",
  "boq_revisions",
  "budget_alerts",
  "budget_revisions",
  "client_portal_users",
  "client_project_access",
  "suppliers",
  "commitments",
  "commitment_lines",
  "company_compliance_profiles",
  "company_feature_flag_overrides",
  "company_invites",
  "company_tax_identifiers",
  "company_tax_overrides",
  "compliance_audit_events",
  "compliance_periods",
  "compliance_exceptions",
  "compliance_workforce_snapshots",
  "employees",
  "files",
  "forecast_snapshots",
  "gosi_compliance_records",
  "quotes",
  "invoices",
  "ipcs",
  "ipc_lines",
  "payroll_periods",
  "payroll_import_batches",
  "payroll_records",
  "labor_allocations",
  "labor_cost_postings",
  "measurements",
  "measurement_lines",
  "nitaqat_compliance_records",
  "notifications",
  "payroll_import_rows",
  "project_punch_items",
  "project_tasks",
  "project_task_dependencies",
  "subcontract_ipcs",
  "subcontract_ipc_lines",
  "zatca_egs_units",
  "zatca_csr_instances",
  "zatca_compliance_lifecycles",
  "zatca_compliance_attempts",
  "zatca_icv_counters",
  "zatca_provider_operations",
  "zatca_submissions",
] as const;

// Tables with no company_id column of their own — scoped through
// project_id -> projects.company_id.
export const TENANT_PROJECT_SCOPED_TABLES = ["budget_items", "expenses", "tasks", "change_orders", "daily_logs"] as const;

// Line-item tables scoped through one specific parent row's id — the
// parent itself is always one of TENANT_DIRECT_TABLES above (already
// filtered by company_id), so joining on the parent's id alone is a safe,
// correct scope.
export const TENANT_PARENT_SCOPED_TABLES = [
  { table: "quote_items", parentTable: "quotes", parentIdColumn: "quote_id" },
  { table: "invoice_items", parentTable: "invoices", parentIdColumn: "invoice_id" },
  { table: "boq_items", parentTable: "boq_revisions", parentIdColumn: "boq_revision_id" },
] as const;

// The exact insertion order for import — computed by topologically
// sorting TENANT_DIRECT_TABLES + TENANT_PROJECT_SCOPED_TABLES +
// TENANT_PARENT_SCOPED_TABLES by their real FK dependency graph (see this
// file's header comment). Export uses the same order for readability/
// determinism, though export itself has no ordering CONSTRAINT the way
// import does.
export const TENANT_TABLE_ORDER = [
  "users",
  "audit_events",
  "customers",
  "projects",
  "cost_codes",
  "contracts",
  "boq_revisions",
  "boq_items",
  "budget_alerts",
  "budget_revisions",
  "budget_items",
  "change_orders",
  "client_portal_users",
  "client_project_access",
  "suppliers",
  "commitments",
  "commitment_lines",
  "company_compliance_profiles",
  "company_feature_flag_overrides",
  "company_invites",
  "company_tax_identifiers",
  "company_tax_overrides",
  "compliance_audit_events",
  "compliance_periods",
  "compliance_exceptions",
  "compliance_workforce_snapshots",
  "daily_logs",
  "employees",
  "expenses",
  "files",
  "forecast_snapshots",
  "gosi_compliance_records",
  "quotes",
  "invoices",
  "invoice_items",
  "ipcs",
  "ipc_lines",
  "payroll_periods",
  "payroll_import_batches",
  "payroll_records",
  "labor_allocations",
  "labor_cost_postings",
  "measurements",
  "measurement_lines",
  "nitaqat_compliance_records",
  "notifications",
  "payroll_import_rows",
  "project_punch_items",
  "project_tasks",
  "project_task_dependencies",
  "quote_items",
  "subcontract_ipcs",
  "subcontract_ipc_lines",
  "tasks",
  "zatca_egs_units",
  "zatca_csr_instances",
  "zatca_compliance_lifecycles",
  "zatca_compliance_attempts",
  "zatca_icv_counters",
  "zatca_provider_operations",
  "zatca_submissions",
] as const;

// Columns never included in an export, regardless of table — credential
// material. Redacted (the column is simply omitted from every exported
// row), never included-but-masked, so there is no representation of "a
// secret used to exist here" to accidentally misuse.
export const TENANT_REDACTED_COLUMNS: Record<string, string[]> = {
  users: ["password_hash"],
  zatca_egs_units: ["secret_ref"],
};

// Document BYTES (the actual file content in storage — local disk or S3)
// are deliberately never bundled into the export JSON itself: streaming
// arbitrary-sized binary content through this same manifest/checksum
// pipeline is a materially different engineering problem (storage-
// provider-aware streaming, size limits, a separate archive format) than
// exporting relational rows, and claiming it works without building and
// testing that separately would be exactly the kind of fabricated
// completeness this audit forbids. The `files` table's own ROWS (path,
// size, mimetype, entity linkage) ARE exported — see TENANT_DIRECT_TABLES
// above — so a restore target knows exactly which documents existed and
// where they pointed, even though the bytes themselves must be migrated
// through the storage layer separately (documented in the export
// manifest's own `includesDocumentBytes: false` field).
export const TENANT_EXPORT_INCLUDES_DOCUMENT_BYTES = false;
