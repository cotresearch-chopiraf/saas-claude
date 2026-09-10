CREATE TYPE "public"."project_task_status" AS ENUM('not_started', 'in_progress', 'completed', 'on_hold');--> statement-breakpoint
CREATE TYPE "public"."project_task_type" AS ENUM('task', 'milestone');--> statement-breakpoint
CREATE TYPE "public"."task_dependency_type" AS ENUM('FS');--> statement-breakpoint
CREATE TABLE "project_task_dependencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"predecessor_task_id" uuid NOT NULL,
	"successor_task_id" uuid NOT NULL,
	"dependency_type" "task_dependency_type" DEFAULT 'FS' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"parent_task_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"task_type" "project_task_type" DEFAULT 'task' NOT NULL,
	"status" "project_task_status" DEFAULT 'not_started' NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"progress_percent" integer DEFAULT 0 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "project_tasks_date_order" CHECK ("project_tasks"."start_date" <= "project_tasks"."end_date"),
	CONSTRAINT "project_tasks_progress_range" CHECK ("project_tasks"."progress_percent" >= 0 AND "project_tasks"."progress_percent" <= 100)
);
--> statement-breakpoint
ALTER TABLE "project_task_dependencies" ADD CONSTRAINT "project_task_dependencies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_task_dependencies" ADD CONSTRAINT "project_task_dependencies_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_task_dependencies" ADD CONSTRAINT "project_task_dependencies_predecessor_task_id_project_tasks_id_fk" FOREIGN KEY ("predecessor_task_id") REFERENCES "public"."project_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_task_dependencies" ADD CONSTRAINT "project_task_dependencies_successor_task_id_project_tasks_id_fk" FOREIGN KEY ("successor_task_id") REFERENCES "public"."project_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_task_dependencies" ADD CONSTRAINT "project_task_dependencies_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_tasks" ADD CONSTRAINT "project_tasks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_tasks" ADD CONSTRAINT "project_tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_tasks" ADD CONSTRAINT "project_tasks_parent_task_id_project_tasks_id_fk" FOREIGN KEY ("parent_task_id") REFERENCES "public"."project_tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_tasks" ADD CONSTRAINT "project_tasks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_task_dependencies_project_idx" ON "project_task_dependencies" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_task_dependencies_predecessor_idx" ON "project_task_dependencies" USING btree ("predecessor_task_id");--> statement-breakpoint
CREATE INDEX "project_task_dependencies_successor_idx" ON "project_task_dependencies" USING btree ("successor_task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_task_dependencies_unique_edge" ON "project_task_dependencies" USING btree ("project_id","predecessor_task_id","successor_task_id");--> statement-breakpoint
CREATE INDEX "project_tasks_project_idx" ON "project_tasks" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_tasks_parent_idx" ON "project_tasks" USING btree ("parent_task_id");