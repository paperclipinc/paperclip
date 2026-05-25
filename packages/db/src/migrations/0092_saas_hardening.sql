CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" text,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "jwt_signing_key" text;--> statement-breakpoint
ALTER TABLE "subscription_plans" ADD COLUMN "max_storage_bytes" bigint;--> statement-breakpoint
ALTER TABLE "subscription_plans" ADD COLUMN "max_issues" integer;--> statement-breakpoint
ALTER TABLE "subscription_plans" ADD COLUMN "max_projects" integer;