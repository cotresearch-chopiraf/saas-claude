CREATE TYPE "public"."punch_item_priority" AS ENUM('low', 'medium', 'high', 'critical');--> statement-breakpoint
CREATE TYPE "public"."punch_item_status" AS ENUM('open', 'assigned', 'in_progress', 'resolved', 'verified', 'closed');--> statement-breakpoint
CREATE TABLE "project_punch_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"location" text,
	"priority" "punch_item_priority" DEFAULT 'medium' NOT NULL,
	"status" "punch_item_status" DEFAULT 'open' NOT NULL,
	"assigned_to_user_id" uuid,
	"due_date" date,
	"resolution_description" text,
	"resolved_at" timestamp,
	"resolved_by_user_id" uuid,
	"verified_at" timestamp,
	"verified_by_user_id" uuid,
	"closed_at" timestamp,
	"closed_by_user_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_punch_items" ADD CONSTRAINT "project_punch_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_punch_items" ADD CONSTRAINT "project_punch_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_punch_items" ADD CONSTRAINT "project_punch_items_assigned_to_user_id_users_id_fk" FOREIGN KEY ("assigned_to_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_punch_items" ADD CONSTRAINT "project_punch_items_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_punch_items" ADD CONSTRAINT "project_punch_items_verified_by_user_id_users_id_fk" FOREIGN KEY ("verified_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_punch_items" ADD CONSTRAINT "project_punch_items_closed_by_user_id_users_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_punch_items" ADD CONSTRAINT "project_punch_items_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_punch_items_project_idx" ON "project_punch_items" USING btree ("project_id");