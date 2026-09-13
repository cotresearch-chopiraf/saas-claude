CREATE TABLE "platform_operator_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform_operator_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"revoked_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "platform_operator_sessions" ADD CONSTRAINT "platform_operator_sessions_platform_operator_id_platform_operators_id_fk" FOREIGN KEY ("platform_operator_id") REFERENCES "public"."platform_operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "platform_operator_sessions_operator_idx" ON "platform_operator_sessions" USING btree ("platform_operator_id");