CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"limits" jsonb DEFAULT '{"maxUsers":null,"maxProjects":null,"maxStorageMb":null,"maxInvoicesPerMonth":null}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "plan_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "plans_key_unique" ON "plans" USING btree ("key");--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE set null ON UPDATE no action;