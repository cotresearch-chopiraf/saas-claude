DO $$ BEGIN
 CREATE TYPE "public"."user_status" AS ENUM('active', 'deactivated');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "status" "user_status" DEFAULT 'active' NOT NULL;