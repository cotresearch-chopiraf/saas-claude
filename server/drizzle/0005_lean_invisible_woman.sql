DO $$ BEGIN
 CREATE TYPE "public"."document_language" AS ENUM('ar', 'fr', 'en');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "language" "document_language" DEFAULT 'ar' NOT NULL;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "language" "document_language" DEFAULT 'ar' NOT NULL;