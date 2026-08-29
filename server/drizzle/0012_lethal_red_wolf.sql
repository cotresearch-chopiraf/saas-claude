DO $$ BEGIN
 CREATE TYPE "public"."forecast_method" AS ENUM('cost_to_complete', 'commitment_aware');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "forecast_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"as_of_date" date NOT NULL,
	"method" "forecast_method" NOT NULL,
	"currency" text NOT NULL,
	"cost_plan" numeric(14, 2) NOT NULL,
	"actual_cost" numeric(14, 2) NOT NULL,
	"committed_cost" numeric(14, 2) NOT NULL,
	"certified_value" numeric(14, 2) NOT NULL,
	"remaining_cost" numeric(14, 2) NOT NULL,
	"etc" numeric(14, 2) NOT NULL,
	"eac" numeric(14, 2) NOT NULL,
	"variance" numeric(14, 2) NOT NULL,
	"variance_percent" numeric(9, 2),
	"assumptions" jsonb NOT NULL,
	"notes" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "forecast_snapshots" ADD CONSTRAINT "forecast_snapshots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "forecast_snapshots" ADD CONSTRAINT "forecast_snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "forecast_snapshots" ADD CONSTRAINT "forecast_snapshots_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
