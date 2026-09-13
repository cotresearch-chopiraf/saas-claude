ALTER TYPE "public"."idempotency_operation" ADD VALUE 'ipc.certify';--> statement-breakpoint
ALTER TYPE "public"."idempotency_operation" ADD VALUE 'subcontractIpc.certify';--> statement-breakpoint
ALTER TYPE "public"."idempotency_operation" ADD VALUE 'changeOrder.approve';--> statement-breakpoint
ALTER TYPE "public"."idempotency_operation" ADD VALUE 'payroll.post';