DO $$ BEGIN
 CREATE TYPE "public"."zatca_csid_status" AS ENUM('none', 'compliance_pending', 'compliance_issued', 'production_issued', 'expired', 'revoked');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."zatca_document_type" AS ENUM('388', '381', '383');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."zatca_egs_status" AS ENUM('not_onboarded', 'onboarding', 'active', 'revoked', 'deactivated');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."zatca_environment" AS ENUM('simulation', 'production');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."zatca_submission_state" AS ENUM('not_submitted', 'ready_for_submission', 'submitting', 'submitted', 'cleared', 'reported', 'rejected', 'retry_required', 'compliance_pending', 'compliance_failed');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "zatca_egs_units" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"environment" "zatca_environment" NOT NULL,
	"status" "zatca_egs_status" DEFAULT 'not_onboarded' NOT NULL,
	"onboarding_status" text,
	"csid_status" "zatca_csid_status" DEFAULT 'none' NOT NULL,
	"certificate_expires_at" timestamp,
	"secret_ref" text,
	"last_document_hash" text,
	"last_communication_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "zatca_icv_counters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"egs_unit_id" uuid NOT NULL,
	"value" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "zatca_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"egs_unit_id" uuid NOT NULL,
	"invoice_id" uuid,
	"credit_note_id" uuid,
	"debit_note_id" uuid,
	"document_type_code" "zatca_document_type" NOT NULL,
	"subtype" text NOT NULL,
	"uuid" uuid NOT NULL,
	"icv" integer NOT NULL,
	"pih" text NOT NULL,
	"document_hash" text NOT NULL,
	"environment" "zatca_environment" NOT NULL,
	"state" "zatca_submission_state" DEFAULT 'not_submitted' NOT NULL,
	"zatca_status" text,
	"zatca_error_code" text,
	"zatca_error_message" text,
	"warnings" jsonb,
	"request_id" text,
	"correlation_id" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"submitted_at" timestamp,
	"responded_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "zatca_submissions_uuid_unique" UNIQUE("uuid")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "zatca_egs_units" ADD CONSTRAINT "zatca_egs_units_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "zatca_icv_counters" ADD CONSTRAINT "zatca_icv_counters_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "zatca_icv_counters" ADD CONSTRAINT "zatca_icv_counters_egs_unit_id_zatca_egs_units_id_fk" FOREIGN KEY ("egs_unit_id") REFERENCES "public"."zatca_egs_units"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "zatca_submissions" ADD CONSTRAINT "zatca_submissions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "zatca_submissions" ADD CONSTRAINT "zatca_submissions_egs_unit_id_zatca_egs_units_id_fk" FOREIGN KEY ("egs_unit_id") REFERENCES "public"."zatca_egs_units"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "zatca_submissions" ADD CONSTRAINT "zatca_submissions_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "zatca_egs_units_company_idx" ON "zatca_egs_units" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "zatca_icv_counters_company_egs_unique" ON "zatca_icv_counters" USING btree ("company_id","egs_unit_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "zatca_submissions_company_idx" ON "zatca_submissions" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "zatca_submissions_egs_unit_idx" ON "zatca_submissions" USING btree ("egs_unit_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "zatca_submissions_invoice_idx" ON "zatca_submissions" USING btree ("invoice_id");--> statement-breakpoint
-- drizzle-kit 0.24.2 does not emit CHECK constraints declared via the
-- schema's check() builder (verified: schema.ts declares
-- zatca_submissions_exactly_one_document_reference, but this file's
-- codegen omitted it) — added by hand so the invariant "exactly one of
-- invoice_id/credit_note_id/debit_note_id is set" is enforced by Postgres
-- itself, not application code alone.
DO $$ BEGIN
 ALTER TABLE "zatca_submissions" ADD CONSTRAINT "zatca_submissions_exactly_one_document_reference" CHECK (
   (
     (CASE WHEN "invoice_id" IS NOT NULL THEN 1 ELSE 0 END) +
     (CASE WHEN "credit_note_id" IS NOT NULL THEN 1 ELSE 0 END) +
     (CASE WHEN "debit_note_id" IS NOT NULL THEN 1 ELSE 0 END)
   ) = 1
 );
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;