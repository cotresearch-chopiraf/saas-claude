CREATE TABLE "company_feature_flag_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"flag_key" text NOT NULL,
	"enabled" boolean NOT NULL,
	"set_by_platform_operator_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feature_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"description" text NOT NULL,
	"global_enabled" boolean DEFAULT false NOT NULL,
	"default_enabled_for_orgs" boolean DEFAULT false NOT NULL,
	"enabled_environments" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "feature_flags_key_unique" ON "feature_flags" USING btree ("key");--> statement-breakpoint
ALTER TABLE "company_feature_flag_overrides" ADD CONSTRAINT "company_feature_flag_overrides_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_feature_flag_overrides" ADD CONSTRAINT "company_feature_flag_overrides_flag_key_feature_flags_key_fk" FOREIGN KEY ("flag_key") REFERENCES "public"."feature_flags"("key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_feature_flag_overrides" ADD CONSTRAINT "company_feature_flag_overrides_set_by_platform_operator_id_platform_operators_id_fk" FOREIGN KEY ("set_by_platform_operator_id") REFERENCES "public"."platform_operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_feature_flag_overrides_company_flag_unique" ON "company_feature_flag_overrides" USING btree ("company_id","flag_key");--> statement-breakpoint
CREATE INDEX "company_feature_flag_overrides_company_idx" ON "company_feature_flag_overrides" USING btree ("company_id");
