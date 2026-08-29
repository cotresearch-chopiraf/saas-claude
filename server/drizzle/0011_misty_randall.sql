DO $$ BEGIN
 CREATE TYPE "public"."ipc_status" AS ENUM('draft', 'submitted', 'approved', 'certified', 'rejected');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ipc_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"ipc_id" uuid NOT NULL,
	"boq_item_id" uuid NOT NULL,
	"description" text,
	"current_quantity" numeric(14, 3) NOT NULL,
	"rate" numeric(14, 2) NOT NULL,
	"current_value" numeric(14, 2) NOT NULL,
	"previous_certified_quantity" numeric(14, 3),
	"previous_certified_value" numeric(14, 2),
	"cumulative_quantity" numeric(14, 3),
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ipcs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"boq_revision_id" uuid NOT NULL,
	"ipc_number" integer NOT NULL,
	"status" "ipc_status" DEFAULT 'draft' NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"notes" text,
	"gross_value" numeric(14, 2),
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
DO $$ BEGIN
 ALTER TABLE "ipc_lines" ADD CONSTRAINT "ipc_lines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ipc_lines" ADD CONSTRAINT "ipc_lines_ipc_id_ipcs_id_fk" FOREIGN KEY ("ipc_id") REFERENCES "public"."ipcs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ipc_lines" ADD CONSTRAINT "ipc_lines_boq_item_id_boq_items_id_fk" FOREIGN KEY ("boq_item_id") REFERENCES "public"."boq_items"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ipcs" ADD CONSTRAINT "ipcs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ipcs" ADD CONSTRAINT "ipcs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ipcs" ADD CONSTRAINT "ipcs_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ipcs" ADD CONSTRAINT "ipcs_boq_revision_id_boq_revisions_id_fk" FOREIGN KEY ("boq_revision_id") REFERENCES "public"."boq_revisions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ipcs" ADD CONSTRAINT "ipcs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ipcs" ADD CONSTRAINT "ipcs_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ipcs" ADD CONSTRAINT "ipcs_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ipcs" ADD CONSTRAINT "ipcs_certified_by_users_id_fk" FOREIGN KEY ("certified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ipcs" ADD CONSTRAINT "ipcs_rejected_by_users_id_fk" FOREIGN KEY ("rejected_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
