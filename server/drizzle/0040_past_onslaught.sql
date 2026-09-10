CREATE TYPE "public"."compliance_exception_severity" AS ENUM('low', 'medium', 'high', 'critical');--> statement-breakpoint
CREATE TYPE "public"."compliance_exception_status" AS ENUM('open', 'in_progress', 'resolved', 'closed');--> statement-breakpoint
CREATE TYPE "public"."compliance_period_status" AS ENUM('open', 'closed');--> statement-breakpoint
CREATE TYPE "public"."compliance_source_type" AS ENUM('manual', 'csv_import', 'excel_import', 'external_reference');--> statement-breakpoint
CREATE TYPE "public"."compliance_verification_status" AS ENUM('unverified', 'pending_verification', 'verified');--> statement-breakpoint
CREATE TYPE "public"."gosi_status" AS ENUM('not_recorded', 'recorded', 'pending_verification', 'verified', 'exception');--> statement-breakpoint
CREATE TABLE "compliance_exceptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"compliance_period_id" uuid,
	"category" text,
	"description" text NOT NULL,
	"severity" "compliance_exception_severity" DEFAULT 'medium' NOT NULL,
	"status" "compliance_exception_status" DEFAULT 'open' NOT NULL,
	"due_date" date,
	"resolved_at" timestamp,
	"resolved_by_user_id" uuid,
	"closed_at" timestamp,
	"closed_by_user_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compliance_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"label" text,
	"status" "compliance_period_status" DEFAULT 'open' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "compliance_periods_date_order" CHECK ("compliance_periods"."period_start" <= "compliance_periods"."period_end")
);
--> statement-breakpoint
CREATE TABLE "compliance_workforce_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"compliance_period_id" uuid NOT NULL,
	"snapshot_date" date NOT NULL,
	"total_employees" integer NOT NULL,
	"saudi_employees" integer NOT NULL,
	"non_saudi_employees" integer NOT NULL,
	"source_type" "compliance_source_type" DEFAULT 'manual' NOT NULL,
	"source_reference" text,
	"verification_status" "compliance_verification_status" DEFAULT 'unverified' NOT NULL,
	"verified_at" timestamp,
	"verified_by_user_id" uuid,
	"notes" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "compliance_workforce_snapshots_counts_non_negative" CHECK ("compliance_workforce_snapshots"."total_employees" >= 0 AND "compliance_workforce_snapshots"."saudi_employees" >= 0 AND "compliance_workforce_snapshots"."non_saudi_employees" >= 0),
	CONSTRAINT "compliance_workforce_snapshots_counts_sum" CHECK ("compliance_workforce_snapshots"."saudi_employees" + "compliance_workforce_snapshots"."non_saudi_employees" = "compliance_workforce_snapshots"."total_employees")
);
--> statement-breakpoint
CREATE TABLE "gosi_compliance_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"compliance_period_id" uuid NOT NULL,
	"registered_employee_count" integer,
	"contribution_status" "gosi_status" DEFAULT 'not_recorded' NOT NULL,
	"submission_status" "gosi_status" DEFAULT 'not_recorded' NOT NULL,
	"payment_status" "gosi_status" DEFAULT 'not_recorded' NOT NULL,
	"source_type" "compliance_source_type" DEFAULT 'manual' NOT NULL,
	"verification_status" "compliance_verification_status" DEFAULT 'unverified' NOT NULL,
	"external_reference" text,
	"verified_at" timestamp,
	"verified_by_user_id" uuid,
	"notes" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "gosi_compliance_records_count_non_negative" CHECK ("gosi_compliance_records"."registered_employee_count" IS NULL OR "gosi_compliance_records"."registered_employee_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "nitaqat_compliance_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"compliance_period_id" uuid NOT NULL,
	"source_type" "compliance_source_type" DEFAULT 'manual' NOT NULL,
	"verification_status" "compliance_verification_status" DEFAULT 'unverified' NOT NULL,
	"classification" text,
	"saudi_count" integer NOT NULL,
	"non_saudi_count" integer NOT NULL,
	"total_count" integer NOT NULL,
	"external_reference" text,
	"verified_at" timestamp,
	"verified_by_user_id" uuid,
	"notes" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "nitaqat_compliance_records_counts_non_negative" CHECK ("nitaqat_compliance_records"."saudi_count" >= 0 AND "nitaqat_compliance_records"."non_saudi_count" >= 0 AND "nitaqat_compliance_records"."total_count" >= 0),
	CONSTRAINT "nitaqat_compliance_records_counts_sum" CHECK ("nitaqat_compliance_records"."saudi_count" + "nitaqat_compliance_records"."non_saudi_count" = "nitaqat_compliance_records"."total_count")
);
--> statement-breakpoint
ALTER TABLE "compliance_exceptions" ADD CONSTRAINT "compliance_exceptions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_exceptions" ADD CONSTRAINT "compliance_exceptions_compliance_period_id_compliance_periods_id_fk" FOREIGN KEY ("compliance_period_id") REFERENCES "public"."compliance_periods"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_exceptions" ADD CONSTRAINT "compliance_exceptions_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_exceptions" ADD CONSTRAINT "compliance_exceptions_closed_by_user_id_users_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_exceptions" ADD CONSTRAINT "compliance_exceptions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_periods" ADD CONSTRAINT "compliance_periods_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_periods" ADD CONSTRAINT "compliance_periods_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_workforce_snapshots" ADD CONSTRAINT "compliance_workforce_snapshots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_workforce_snapshots" ADD CONSTRAINT "compliance_workforce_snapshots_compliance_period_id_compliance_periods_id_fk" FOREIGN KEY ("compliance_period_id") REFERENCES "public"."compliance_periods"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_workforce_snapshots" ADD CONSTRAINT "compliance_workforce_snapshots_verified_by_user_id_users_id_fk" FOREIGN KEY ("verified_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_workforce_snapshots" ADD CONSTRAINT "compliance_workforce_snapshots_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gosi_compliance_records" ADD CONSTRAINT "gosi_compliance_records_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gosi_compliance_records" ADD CONSTRAINT "gosi_compliance_records_compliance_period_id_compliance_periods_id_fk" FOREIGN KEY ("compliance_period_id") REFERENCES "public"."compliance_periods"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gosi_compliance_records" ADD CONSTRAINT "gosi_compliance_records_verified_by_user_id_users_id_fk" FOREIGN KEY ("verified_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gosi_compliance_records" ADD CONSTRAINT "gosi_compliance_records_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nitaqat_compliance_records" ADD CONSTRAINT "nitaqat_compliance_records_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nitaqat_compliance_records" ADD CONSTRAINT "nitaqat_compliance_records_compliance_period_id_compliance_periods_id_fk" FOREIGN KEY ("compliance_period_id") REFERENCES "public"."compliance_periods"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nitaqat_compliance_records" ADD CONSTRAINT "nitaqat_compliance_records_verified_by_user_id_users_id_fk" FOREIGN KEY ("verified_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nitaqat_compliance_records" ADD CONSTRAINT "nitaqat_compliance_records_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "compliance_exceptions_company_idx" ON "compliance_exceptions" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "compliance_exceptions_period_idx" ON "compliance_exceptions" USING btree ("compliance_period_id");--> statement-breakpoint
CREATE INDEX "compliance_periods_company_idx" ON "compliance_periods" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "compliance_periods_company_period_unique" ON "compliance_periods" USING btree ("company_id","period_start","period_end");--> statement-breakpoint
CREATE INDEX "compliance_workforce_snapshots_company_idx" ON "compliance_workforce_snapshots" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "compliance_workforce_snapshots_period_idx" ON "compliance_workforce_snapshots" USING btree ("compliance_period_id");--> statement-breakpoint
CREATE INDEX "gosi_compliance_records_company_idx" ON "gosi_compliance_records" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "gosi_compliance_records_period_idx" ON "gosi_compliance_records" USING btree ("compliance_period_id");--> statement-breakpoint
CREATE INDEX "nitaqat_compliance_records_company_idx" ON "nitaqat_compliance_records" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "nitaqat_compliance_records_period_idx" ON "nitaqat_compliance_records" USING btree ("compliance_period_id");