DO $$ BEGIN
 CREATE TYPE "public"."compliance_status" AS ENUM('configured', 'partially_configured', 'review_required');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."country_code" AS ENUM('SA', 'AE', 'QA', 'KW', 'BH', 'OM', 'MA');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."override_status" AS ENUM('active', 'reset');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."rule_version_status" AS ENUM('draft', 'published', 'superseded');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."source_type" AS ENUM('official_government', 'official_regulation', 'verified_professional');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "company_compliance_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"country_code" "country_code" NOT NULL,
	"legal_entity_type" text,
	"business_activity" text,
	"tax_registration_status" text,
	"active_rule_version_id" uuid NOT NULL,
	"status" "compliance_status" DEFAULT 'configured' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "company_compliance_profiles_company_id_unique" UNIQUE("company_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "company_tax_identifiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"identifier_type" text NOT NULL,
	"value" text NOT NULL,
	"country_code" "country_code" NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "company_tax_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"setting_key" text NOT NULL,
	"override_value" jsonb NOT NULL,
	"official_default_snapshot" jsonb NOT NULL,
	"rule_version_id" uuid NOT NULL,
	"status" "override_status" DEFAULT 'active' NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"reason" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"reset_at" timestamp,
	"reset_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "compliance_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"setting_key" text,
	"previous_value" jsonb,
	"new_value" jsonb,
	"official_default_at_time" jsonb,
	"country_code" "country_code",
	"rule_version_id" uuid,
	"changed_by" uuid NOT NULL,
	"reason" text,
	"effective_from" date,
	"effective_to" date,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "compliance_rule_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"country_code" "country_code" NOT NULL,
	"version" text NOT NULL,
	"status" "rule_version_status" DEFAULT 'draft' NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"rules" jsonb NOT NULL,
	"source_url" text,
	"source_type" "source_type",
	"publication_date" date,
	"retrieved_at" timestamp,
	"verification_status" text DEFAULT 'unverified' NOT NULL,
	"published_at" timestamp,
	"published_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "tax_category" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "rule_version_id" uuid;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "override_reference" uuid;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "tax_category" text;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "tax_rate_percent" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "rule_version_id" uuid;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "override_reference" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_compliance_profiles" ADD CONSTRAINT "company_compliance_profiles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_compliance_profiles" ADD CONSTRAINT "company_compliance_profiles_active_rule_version_id_compliance_rule_versions_id_fk" FOREIGN KEY ("active_rule_version_id") REFERENCES "public"."compliance_rule_versions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_tax_identifiers" ADD CONSTRAINT "company_tax_identifiers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_tax_overrides" ADD CONSTRAINT "company_tax_overrides_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_tax_overrides" ADD CONSTRAINT "company_tax_overrides_rule_version_id_compliance_rule_versions_id_fk" FOREIGN KEY ("rule_version_id") REFERENCES "public"."compliance_rule_versions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_tax_overrides" ADD CONSTRAINT "company_tax_overrides_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_tax_overrides" ADD CONSTRAINT "company_tax_overrides_reset_by_users_id_fk" FOREIGN KEY ("reset_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "compliance_audit_events" ADD CONSTRAINT "compliance_audit_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "compliance_audit_events" ADD CONSTRAINT "compliance_audit_events_rule_version_id_compliance_rule_versions_id_fk" FOREIGN KEY ("rule_version_id") REFERENCES "public"."compliance_rule_versions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "compliance_audit_events" ADD CONSTRAINT "compliance_audit_events_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "compliance_rule_versions" ADD CONSTRAINT "compliance_rule_versions_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoices" ADD CONSTRAINT "invoices_rule_version_id_compliance_rule_versions_id_fk" FOREIGN KEY ("rule_version_id") REFERENCES "public"."compliance_rule_versions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoices" ADD CONSTRAINT "invoices_override_reference_company_tax_overrides_id_fk" FOREIGN KEY ("override_reference") REFERENCES "public"."company_tax_overrides"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "quotes" ADD CONSTRAINT "quotes_rule_version_id_compliance_rule_versions_id_fk" FOREIGN KEY ("rule_version_id") REFERENCES "public"."compliance_rule_versions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "quotes" ADD CONSTRAINT "quotes_override_reference_company_tax_overrides_id_fk" FOREIGN KEY ("override_reference") REFERENCES "public"."company_tax_overrides"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
