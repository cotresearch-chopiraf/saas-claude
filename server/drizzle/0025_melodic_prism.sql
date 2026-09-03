DO $$ BEGIN
 CREATE TYPE "public"."zatca_provider_operation_status" AS ENUM('response_received', 'failed');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."zatca_provider_operation_type" AS ENUM('production_csid_onboarding', 'production_csid_renewal');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "zatca_provider_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"egs_unit_id" uuid NOT NULL,
	"operation_type" "zatca_provider_operation_type" NOT NULL,
	"internal_status" "zatca_provider_operation_status" NOT NULL,
	"provider_request_id" text,
	"disposition_message" text,
	"provider_outcome" text,
	"secret_ref" text,
	"error_category" text,
	"started_at" timestamp NOT NULL,
	"finished_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "zatca_provider_operations" ADD CONSTRAINT "zatca_provider_operations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "zatca_provider_operations" ADD CONSTRAINT "zatca_provider_operations_egs_unit_id_zatca_egs_units_id_fk" FOREIGN KEY ("egs_unit_id") REFERENCES "public"."zatca_egs_units"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "zatca_provider_operations_egs_unit_idx" ON "zatca_provider_operations" USING btree ("egs_unit_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "zatca_provider_operations_company_idx" ON "zatca_provider_operations" USING btree ("company_id");