CREATE TABLE IF NOT EXISTS "zatca_compliance_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"compliance_lifecycle_id" uuid NOT NULL,
	"document_type" "zatca_document_type" NOT NULL,
	"correlation_id" text,
	"raw_status" text,
	"normalized_outcome" text,
	"attempted_at" timestamp DEFAULT now() NOT NULL,
	"error_category" text,
	"error_code" text,
	"retry_of_attempt_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "zatca_compliance_attempts" ADD CONSTRAINT "zatca_compliance_attempts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "zatca_compliance_attempts" ADD CONSTRAINT "zatca_compliance_attempts_compliance_lifecycle_id_zatca_compliance_lifecycles_id_fk" FOREIGN KEY ("compliance_lifecycle_id") REFERENCES "public"."zatca_compliance_lifecycles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "zatca_compliance_attempts" ADD CONSTRAINT "zatca_compliance_attempts_retry_of_attempt_id_zatca_compliance_attempts_id_fk" FOREIGN KEY ("retry_of_attempt_id") REFERENCES "public"."zatca_compliance_attempts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "zatca_compliance_attempts_lifecycle_idx" ON "zatca_compliance_attempts" USING btree ("compliance_lifecycle_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "zatca_compliance_attempts_company_idx" ON "zatca_compliance_attempts" USING btree ("company_id");