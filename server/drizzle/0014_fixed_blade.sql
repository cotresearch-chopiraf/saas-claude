DO $$ BEGIN
 CREATE TYPE "public"."subcontract_ipc_status" AS ENUM('draft', 'submitted', 'approved', 'certified', 'rejected');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subcontract_ipc_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"subcontract_ipc_id" uuid NOT NULL,
	"commitment_line_id" uuid NOT NULL,
	"description" text,
	"current_quantity" numeric(14, 3),
	"rate" numeric(14, 2),
	"current_value" numeric(14, 2) NOT NULL,
	"previous_certified_quantity" numeric(14, 3),
	"cumulative_quantity" numeric(14, 3),
	"previous_certified_value" numeric(14, 2),
	"cumulative_value" numeric(14, 2),
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subcontract_ipcs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"commitment_id" uuid NOT NULL,
	"ipc_number" integer NOT NULL,
	"status" "subcontract_ipc_status" DEFAULT 'draft' NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"notes" text,
	"gross_value" numeric(14, 2),
	"retention_percent" numeric(5, 2),
	"retention_amount" numeric(14, 2),
	"advance_recovery_amount" numeric(14, 2),
	"other_deductions" numeric(14, 2),
	"net_certified" numeric(14, 2),
	"currency" text DEFAULT 'SAR' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"submitted_by" uuid,
	"submitted_at" timestamp,
	"approved_by" uuid,
	"approved_at" timestamp,
	"certified_by" uuid,
	"certified_at" timestamp,
	"rejected_by" uuid,
	"rejected_at" timestamp,
	"rejection_reason" text
);
--> statement-breakpoint
ALTER TABLE "commitments" ADD COLUMN "retention_percent" numeric(5, 2);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "subcontract_ipc_lines" ADD CONSTRAINT "subcontract_ipc_lines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "subcontract_ipc_lines" ADD CONSTRAINT "subcontract_ipc_lines_subcontract_ipc_id_subcontract_ipcs_id_fk" FOREIGN KEY ("subcontract_ipc_id") REFERENCES "public"."subcontract_ipcs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "subcontract_ipc_lines" ADD CONSTRAINT "subcontract_ipc_lines_commitment_line_id_commitment_lines_id_fk" FOREIGN KEY ("commitment_line_id") REFERENCES "public"."commitment_lines"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "subcontract_ipcs" ADD CONSTRAINT "subcontract_ipcs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "subcontract_ipcs" ADD CONSTRAINT "subcontract_ipcs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "subcontract_ipcs" ADD CONSTRAINT "subcontract_ipcs_commitment_id_commitments_id_fk" FOREIGN KEY ("commitment_id") REFERENCES "public"."commitments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "subcontract_ipcs" ADD CONSTRAINT "subcontract_ipcs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "subcontract_ipcs" ADD CONSTRAINT "subcontract_ipcs_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "subcontract_ipcs" ADD CONSTRAINT "subcontract_ipcs_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "subcontract_ipcs" ADD CONSTRAINT "subcontract_ipcs_certified_by_users_id_fk" FOREIGN KEY ("certified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "subcontract_ipcs" ADD CONSTRAINT "subcontract_ipcs_rejected_by_users_id_fk" FOREIGN KEY ("rejected_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subcontract_ipc_lines_company_idx" ON "subcontract_ipc_lines" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subcontract_ipc_lines_ipc_idx" ON "subcontract_ipc_lines" USING btree ("subcontract_ipc_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subcontract_ipc_lines_commitment_line_idx" ON "subcontract_ipc_lines" USING btree ("commitment_line_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subcontract_ipcs_company_idx" ON "subcontract_ipcs" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subcontract_ipcs_project_idx" ON "subcontract_ipcs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subcontract_ipcs_commitment_idx" ON "subcontract_ipcs" USING btree ("commitment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subcontract_ipcs_status_idx" ON "subcontract_ipcs" USING btree ("status");