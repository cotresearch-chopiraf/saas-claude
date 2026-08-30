CREATE TABLE IF NOT EXISTS "support_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform_operator_id" uuid NOT NULL,
	"target_company_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"revoked_at" timestamp
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "support_sessions" ADD CONSTRAINT "support_sessions_platform_operator_id_platform_operators_id_fk" FOREIGN KEY ("platform_operator_id") REFERENCES "public"."platform_operators"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "support_sessions" ADD CONSTRAINT "support_sessions_target_company_id_companies_id_fk" FOREIGN KEY ("target_company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
