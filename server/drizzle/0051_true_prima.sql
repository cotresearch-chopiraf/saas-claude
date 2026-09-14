DROP INDEX "company_tax_overrides_one_open_active";--> statement-breakpoint
ALTER TABLE "company_tax_overrides" ADD COLUMN "country_code" "country_code";--> statement-breakpoint
UPDATE "company_tax_overrides" AS o
SET "country_code" = v."country_code"
FROM "compliance_rule_versions" AS v
WHERE v."id" = o."rule_version_id";--> statement-breakpoint
ALTER TABLE "company_tax_overrides" ALTER COLUMN "country_code" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "company_tax_overrides_one_open_active" ON "company_tax_overrides" USING btree ("company_id","setting_key","country_code") WHERE "company_tax_overrides"."status" = 'active' AND "company_tax_overrides"."effective_to" IS NULL;
