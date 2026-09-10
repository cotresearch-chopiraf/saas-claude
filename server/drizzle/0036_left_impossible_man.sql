CREATE TYPE "public"."client_portal_user_status" AS ENUM('active', 'deactivated');--> statement-breakpoint
CREATE TABLE "client_portal_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_portal_user_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"revoked_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "client_portal_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"customer_id" uuid,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"status" "client_portal_user_status" DEFAULT 'active' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "client_portal_users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "client_project_access" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"client_portal_user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"granted_by" uuid NOT NULL,
	"granted_at" timestamp DEFAULT now() NOT NULL,
	"revoked_by" uuid,
	"revoked_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "client_portal_sessions" ADD CONSTRAINT "client_portal_sessions_client_portal_user_id_client_portal_users_id_fk" FOREIGN KEY ("client_portal_user_id") REFERENCES "public"."client_portal_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_portal_users" ADD CONSTRAINT "client_portal_users_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_portal_users" ADD CONSTRAINT "client_portal_users_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_portal_users" ADD CONSTRAINT "client_portal_users_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_project_access" ADD CONSTRAINT "client_project_access_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_project_access" ADD CONSTRAINT "client_project_access_client_portal_user_id_client_portal_users_id_fk" FOREIGN KEY ("client_portal_user_id") REFERENCES "public"."client_portal_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_project_access" ADD CONSTRAINT "client_project_access_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_project_access" ADD CONSTRAINT "client_project_access_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_project_access" ADD CONSTRAINT "client_project_access_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "client_portal_sessions_user_idx" ON "client_portal_sessions" USING btree ("client_portal_user_id");--> statement-breakpoint
CREATE INDEX "client_portal_users_company_idx" ON "client_portal_users" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "client_project_access_user_idx" ON "client_project_access" USING btree ("client_portal_user_id");--> statement-breakpoint
CREATE INDEX "client_project_access_project_idx" ON "client_project_access" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "client_project_access_one_active_per_user_project" ON "client_project_access" USING btree ("client_portal_user_id","project_id") WHERE "client_project_access"."revoked_at" IS NULL;