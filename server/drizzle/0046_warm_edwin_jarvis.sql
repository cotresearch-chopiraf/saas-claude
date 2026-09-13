CREATE TYPE "public"."company_status" AS ENUM('active', 'suspended');--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "status" "company_status" DEFAULT 'active' NOT NULL;