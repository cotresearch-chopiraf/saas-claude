DO $$ BEGIN
 CREATE TYPE "public"."zatca_csr_instance_status" AS ENUM('generated', 'superseded');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "zatca_csr_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"egs_unit_id" uuid NOT NULL,
	"purpose" text,
	"invoice_type" text NOT NULL,
	"secret_ref" text NOT NULL,
	"status" "zatca_csr_instance_status" DEFAULT 'generated' NOT NULL,
	"superseded_by" uuid,
	"generated_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "zatca_csr_instances" ADD CONSTRAINT "zatca_csr_instances_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "zatca_csr_instances" ADD CONSTRAINT "zatca_csr_instances_egs_unit_id_zatca_egs_units_id_fk" FOREIGN KEY ("egs_unit_id") REFERENCES "public"."zatca_egs_units"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "zatca_csr_instances" ADD CONSTRAINT "zatca_csr_instances_superseded_by_zatca_csr_instances_id_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."zatca_csr_instances"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "zatca_csr_instances_egs_unit_idx" ON "zatca_csr_instances" USING btree ("egs_unit_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "zatca_csr_instances_company_idx" ON "zatca_csr_instances" USING btree ("company_id");