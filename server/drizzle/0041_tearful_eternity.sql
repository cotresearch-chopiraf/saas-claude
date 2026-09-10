CREATE TYPE "public"."budget_alert_rule_code" AS ENUM('budget_consumption_threshold', 'forecast_over_budget', 'actual_commitments_over_budget', 'cost_code_risk');--> statement-breakpoint
CREATE TYPE "public"."budget_alert_severity" AS ENUM('info', 'warning', 'critical');--> statement-breakpoint
CREATE TYPE "public"."budget_alert_status" AS ENUM('open', 'acknowledged', 'resolved');--> statement-breakpoint
CREATE TABLE "budget_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"cost_code_id" uuid,
	"rule_code" "budget_alert_rule_code" NOT NULL,
	"severity" "budget_alert_severity" NOT NULL,
	"status" "budget_alert_status" DEFAULT 'open' NOT NULL,
	"metric_type" text NOT NULL,
	"metric_value" numeric(14, 2) NOT NULL,
	"threshold_value" numeric(14, 2) NOT NULL,
	"budget_amount" numeric(14, 2),
	"actual_amount" numeric(14, 2),
	"commitment_amount" numeric(14, 2),
	"forecast_amount" numeric(14, 2),
	"currency" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"recommended_action" text NOT NULL,
	"deduplication_key" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp,
	"acknowledged_by_user_id" uuid,
	"resolved_at" timestamp,
	"resolved_by_user_id" uuid,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "budget_alerts" ADD CONSTRAINT "budget_alerts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_alerts" ADD CONSTRAINT "budget_alerts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_alerts" ADD CONSTRAINT "budget_alerts_cost_code_id_cost_codes_id_fk" FOREIGN KEY ("cost_code_id") REFERENCES "public"."cost_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_alerts" ADD CONSTRAINT "budget_alerts_acknowledged_by_user_id_users_id_fk" FOREIGN KEY ("acknowledged_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_alerts" ADD CONSTRAINT "budget_alerts_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "budget_alerts_company_idx" ON "budget_alerts" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "budget_alerts_project_idx" ON "budget_alerts" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "budget_alerts_open_dedup_unique" ON "budget_alerts" USING btree ("company_id","project_id","deduplication_key") WHERE "budget_alerts"."status" <> 'resolved';