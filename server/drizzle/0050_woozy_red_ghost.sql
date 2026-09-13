CREATE TYPE "public"."incident_severity" AS ENUM('low', 'medium', 'high', 'critical');--> statement-breakpoint
CREATE TYPE "public"."incident_status" AS ENUM('open', 'investigating', 'resolved');--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"severity" "incident_severity" NOT NULL,
	"status" "incident_status" DEFAULT 'open' NOT NULL,
	"affected_service" text NOT NULL,
	"correlation_id" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"resolution_notes" text,
	"created_by_platform_operator_id" uuid,
	"resolved_by_platform_operator_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"resolved_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_created_by_platform_operator_id_platform_operators_id_fk" FOREIGN KEY ("created_by_platform_operator_id") REFERENCES "public"."platform_operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_resolved_by_platform_operator_id_platform_operators_id_fk" FOREIGN KEY ("resolved_by_platform_operator_id") REFERENCES "public"."platform_operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "incidents_company_idx" ON "incidents" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "incidents_status_idx" ON "incidents" USING btree ("status");