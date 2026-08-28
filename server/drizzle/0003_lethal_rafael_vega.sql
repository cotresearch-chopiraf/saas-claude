DO $$ BEGIN
 CREATE TYPE "public"."invoice_status" AS ENUM('draft', 'sent', 'paid');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "invoice_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"description" text NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"quote_id" uuid,
	"invoice_number" text NOT NULL,
	"client_name" text NOT NULL,
	"client_address" text,
	"client_tax_id" text,
	"tax_rate_percent" numeric(5, 2) NOT NULL,
	"status" "invoice_status" DEFAULT 'draft' NOT NULL,
	"public_token" text NOT NULL,
	"issue_date" date NOT NULL,
	"due_date" date,
	"paid_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_public_token_unique" UNIQUE("public_token")
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "logo_path" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "address" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "tax_id" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "default_tax_rate_percent" numeric(5, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "next_quote_number" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "next_invoice_number" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "feature_flags" jsonb DEFAULT '{"invoicing":true}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "quote_number" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoices" ADD CONSTRAINT "invoices_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoices" ADD CONSTRAINT "invoices_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
