-- Add scope column to subscription_plans
ALTER TABLE "subscription_plans" ADD COLUMN "scope" text NOT NULL DEFAULT 'company';

-- Rename cloud -> pro
-- 1. Create the 'pro' plan as a copy of 'cloud' (if cloud exists)
INSERT INTO "subscription_plans" ("id", "name", "stripe_price_id", "monthly_price_cents", "max_agents", "max_companies", "max_monthly_cost_cents", "max_storage_bytes", "max_issues", "max_projects", "features", "scope", "sort_order", "active", "created_at", "updated_at")
  SELECT 'pro', 'Pro', "stripe_price_id", "monthly_price_cents", "max_agents", "max_companies", "max_monthly_cost_cents", "max_storage_bytes", "max_issues", "max_projects", "features", 'company', "sort_order", "active", "created_at", now()
  FROM "subscription_plans" WHERE "id" = 'cloud'
  ON CONFLICT ("id") DO NOTHING;
-- 2. Point FK references from cloud to pro
UPDATE "company_subscriptions" SET "plan_id" = 'pro' WHERE "plan_id" = 'cloud';
-- 3. Remove the old cloud plan
DELETE FROM "subscription_plans" WHERE "id" = 'cloud';

-- Create account_subscriptions table (user-level, for Unlimited plan)
CREATE TABLE IF NOT EXISTS "account_subscriptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" text NOT NULL REFERENCES "user"("id"),
  "plan_id" text NOT NULL REFERENCES "subscription_plans"("id"),
  "stripe_customer_id" text,
  "stripe_subscription_id" text,
  "status" text NOT NULL DEFAULT 'active',
  "current_period_start" timestamp with time zone,
  "current_period_end" timestamp with time zone,
  "cancel_at_period_end" boolean NOT NULL DEFAULT false,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "account_subscriptions_user_idx" ON "account_subscriptions" ("user_id");
CREATE INDEX "account_subscriptions_stripe_customer_idx" ON "account_subscriptions" ("stripe_customer_id");
CREATE INDEX "account_subscriptions_stripe_subscription_idx" ON "account_subscriptions" ("stripe_subscription_id");
