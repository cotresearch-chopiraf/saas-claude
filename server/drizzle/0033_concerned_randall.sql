CREATE TYPE "public"."employee_status" AS ENUM('active', 'inactive');--> statement-breakpoint
CREATE TYPE "public"."labor_cost_posting_kind" AS ENUM('posting', 'reversal');--> statement-breakpoint
CREATE TYPE "public"."payroll_import_batch_status" AS ENUM('uploaded', 'parsing', 'validated', 'ready', 'imported', 'failed');--> statement-breakpoint
CREATE TYPE "public"."payroll_import_row_status" AS ENUM('pending', 'valid', 'invalid', 'imported');--> statement-breakpoint
CREATE TYPE "public"."payroll_period_status" AS ENUM('draft', 'submitted', 'approved', 'posted', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."payroll_record_source_type" AS ENUM('manual', 'csv_import', 'excel_import', 'external_provider');--> statement-breakpoint
CREATE TYPE "public"."payroll_verification_status" AS ENUM('unverified', 'verified');--> statement-breakpoint
CREATE TABLE "employees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid,
	"employee_number" text NOT NULL,
	"name" text NOT NULL,
	"status" "employee_status" DEFAULT 'active' NOT NULL,
	"nationality" text,
	"bank_name" text,
	"iban" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "labor_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"payroll_record_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"cost_code_id" uuid,
	"percentage" numeric(5, 2),
	"amount" numeric(12, 2) NOT NULL,
	"notes" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "labor_cost_postings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"payroll_period_id" uuid NOT NULL,
	"labor_allocation_id" uuid NOT NULL,
	"expense_id" uuid NOT NULL,
	"kind" "labor_cost_posting_kind" DEFAULT 'posting' NOT NULL,
	"reversal_of_posting_id" uuid,
	"posted_by" uuid NOT NULL,
	"posted_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"payroll_period_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"status" "payroll_import_batch_status" DEFAULT 'uploaded' NOT NULL,
	"row_count" integer,
	"valid_row_count" integer,
	"error_row_count" integer,
	"created_by" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"committed_by" uuid,
	"committed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "payroll_import_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"import_batch_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"raw_data" jsonb NOT NULL,
	"parsed_employee_number" text,
	"parsed_amount" numeric(12, 2),
	"validation_errors" jsonb,
	"status" "payroll_import_row_status" DEFAULT 'pending' NOT NULL,
	"resulting_payroll_record_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"payroll_date" date,
	"status" "payroll_period_status" DEFAULT 'draft' NOT NULL,
	"notes" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"submitted_by" uuid,
	"submitted_at" timestamp,
	"approved_by" uuid,
	"approved_at" timestamp,
	"posted_by" uuid,
	"posted_at" timestamp,
	"rejected_by" uuid,
	"rejected_at" timestamp,
	"rejection_reason" text
);
--> statement-breakpoint
CREATE TABLE "payroll_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"payroll_period_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"gross_amount" numeric(12, 2) NOT NULL,
	"deductions_amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"net_amount" numeric(12, 2) NOT NULL,
	"source_type" "payroll_record_source_type" DEFAULT 'manual' NOT NULL,
	"provider" text,
	"external_reference" text,
	"verification_status" "payroll_verification_status" DEFAULT 'unverified' NOT NULL,
	"import_batch_id" uuid,
	"imported_at" timestamp,
	"verified_at" timestamp,
	"created_by" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "cost_code_id" uuid;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labor_allocations" ADD CONSTRAINT "labor_allocations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labor_allocations" ADD CONSTRAINT "labor_allocations_payroll_record_id_payroll_records_id_fk" FOREIGN KEY ("payroll_record_id") REFERENCES "public"."payroll_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labor_allocations" ADD CONSTRAINT "labor_allocations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labor_allocations" ADD CONSTRAINT "labor_allocations_cost_code_id_cost_codes_id_fk" FOREIGN KEY ("cost_code_id") REFERENCES "public"."cost_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labor_allocations" ADD CONSTRAINT "labor_allocations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labor_cost_postings" ADD CONSTRAINT "labor_cost_postings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labor_cost_postings" ADD CONSTRAINT "labor_cost_postings_payroll_period_id_payroll_periods_id_fk" FOREIGN KEY ("payroll_period_id") REFERENCES "public"."payroll_periods"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labor_cost_postings" ADD CONSTRAINT "labor_cost_postings_labor_allocation_id_labor_allocations_id_fk" FOREIGN KEY ("labor_allocation_id") REFERENCES "public"."labor_allocations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labor_cost_postings" ADD CONSTRAINT "labor_cost_postings_expense_id_expenses_id_fk" FOREIGN KEY ("expense_id") REFERENCES "public"."expenses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labor_cost_postings" ADD CONSTRAINT "labor_cost_postings_reversal_of_posting_id_labor_cost_postings_id_fk" FOREIGN KEY ("reversal_of_posting_id") REFERENCES "public"."labor_cost_postings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labor_cost_postings" ADD CONSTRAINT "labor_cost_postings_posted_by_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_import_batches" ADD CONSTRAINT "payroll_import_batches_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_import_batches" ADD CONSTRAINT "payroll_import_batches_payroll_period_id_payroll_periods_id_fk" FOREIGN KEY ("payroll_period_id") REFERENCES "public"."payroll_periods"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_import_batches" ADD CONSTRAINT "payroll_import_batches_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_import_batches" ADD CONSTRAINT "payroll_import_batches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_import_batches" ADD CONSTRAINT "payroll_import_batches_committed_by_users_id_fk" FOREIGN KEY ("committed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_import_rows" ADD CONSTRAINT "payroll_import_rows_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_import_rows" ADD CONSTRAINT "payroll_import_rows_import_batch_id_payroll_import_batches_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."payroll_import_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_import_rows" ADD CONSTRAINT "payroll_import_rows_resulting_payroll_record_id_payroll_records_id_fk" FOREIGN KEY ("resulting_payroll_record_id") REFERENCES "public"."payroll_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_periods" ADD CONSTRAINT "payroll_periods_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_periods" ADD CONSTRAINT "payroll_periods_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_periods" ADD CONSTRAINT "payroll_periods_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_periods" ADD CONSTRAINT "payroll_periods_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_periods" ADD CONSTRAINT "payroll_periods_posted_by_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_periods" ADD CONSTRAINT "payroll_periods_rejected_by_users_id_fk" FOREIGN KEY ("rejected_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_records" ADD CONSTRAINT "payroll_records_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_records" ADD CONSTRAINT "payroll_records_payroll_period_id_payroll_periods_id_fk" FOREIGN KEY ("payroll_period_id") REFERENCES "public"."payroll_periods"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_records" ADD CONSTRAINT "payroll_records_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_records" ADD CONSTRAINT "payroll_records_import_batch_id_payroll_import_batches_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."payroll_import_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_records" ADD CONSTRAINT "payroll_records_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "employees_company_idx" ON "employees" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "employees_company_number_unique" ON "employees" USING btree ("company_id","employee_number");--> statement-breakpoint
CREATE INDEX "labor_allocations_company_idx" ON "labor_allocations" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "labor_allocations_record_idx" ON "labor_allocations" USING btree ("payroll_record_id");--> statement-breakpoint
CREATE INDEX "labor_allocations_project_idx" ON "labor_allocations" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "labor_cost_postings_company_idx" ON "labor_cost_postings" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "labor_cost_postings_period_idx" ON "labor_cost_postings" USING btree ("payroll_period_id");--> statement-breakpoint
CREATE INDEX "labor_cost_postings_allocation_idx" ON "labor_cost_postings" USING btree ("labor_allocation_id");--> statement-breakpoint
CREATE INDEX "payroll_import_batches_company_idx" ON "payroll_import_batches" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "payroll_import_batches_period_idx" ON "payroll_import_batches" USING btree ("payroll_period_id");--> statement-breakpoint
CREATE INDEX "payroll_import_rows_batch_idx" ON "payroll_import_rows" USING btree ("import_batch_id");--> statement-breakpoint
CREATE INDEX "payroll_periods_company_idx" ON "payroll_periods" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_periods_company_period_unique" ON "payroll_periods" USING btree ("company_id","period_start","period_end");--> statement-breakpoint
CREATE INDEX "payroll_records_company_idx" ON "payroll_records" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "payroll_records_period_idx" ON "payroll_records" USING btree ("payroll_period_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_records_period_employee_unique" ON "payroll_records" USING btree ("payroll_period_id","employee_id");--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_cost_code_id_cost_codes_id_fk" FOREIGN KEY ("cost_code_id") REFERENCES "public"."cost_codes"("id") ON DELETE no action ON UPDATE no action;