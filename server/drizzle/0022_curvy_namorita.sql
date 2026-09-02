DO $$ BEGIN
 CREATE TYPE "public"."zatca_compliance_lifecycle_status" AS ENUM('issued');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "zatca_compliance_lifecycles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"csr_instance_id" uuid NOT NULL,
	"request_id" text NOT NULL,
	"disposition_message" text NOT NULL,
	"secret_ref" text NOT NULL,
	"status" "zatca_compliance_lifecycle_status" DEFAULT 'issued' NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "zatca_compliance_lifecycles" ADD CONSTRAINT "zatca_compliance_lifecycles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "zatca_compliance_lifecycles" ADD CONSTRAINT "zatca_compliance_lifecycles_csr_instance_id_zatca_csr_instances_id_fk" FOREIGN KEY ("csr_instance_id") REFERENCES "public"."zatca_csr_instances"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "zatca_compliance_lifecycles_csr_instance_unique" ON "zatca_compliance_lifecycles" USING btree ("csr_instance_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "zatca_compliance_lifecycles_company_idx" ON "zatca_compliance_lifecycles" USING btree ("company_id");