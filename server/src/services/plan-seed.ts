import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { subscriptionPlans } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

/**
 * Ensure subscription plans exist in the database.
 * Idempotent — safe to call on every server startup.
 * Only seeds the cloud plan when Stripe is configured (i.e. cloud deployment).
 */
export async function ensureSubscriptionPlans(db: Db): Promise<void> {
  // Always ensure the free plan exists (used by self-hosted and as fallback)
  await upsertPlan(db, {
    id: "free",
    name: "Free",
    monthlyPriceCents: 0,
    stripePriceId: null,
    maxAgents: null,
    maxCompanies: null,
    maxMonthlyCostCents: null,
    maxStorageBytes: null,
    maxIssues: null,
    maxProjects: null,
    features: null,
    sortOrder: 0,
    active: true,
  });

  // Only seed the cloud plan when Stripe is configured
  const stripeKey = process.env.STRIPE_SECRET_KEY?.trim();
  if (!stripeKey) return;

  const stripePriceId = process.env.STRIPE_PRICE_ID?.trim();
  if (!stripePriceId) {
    logger.warn(
      "STRIPE_SECRET_KEY is set but STRIPE_PRICE_ID is missing. " +
        "The cloud plan will not be purchasable until this is configured.",
    );
  }

  await upsertPlan(db, {
    id: "cloud",
    name: "Cloud",
    monthlyPriceCents: 1500,
    stripePriceId: stripePriceId ?? null,
    maxAgents: null, // unlimited
    maxCompanies: null,
    maxMonthlyCostCents: null,
    maxStorageBytes: null,
    maxIssues: null,
    maxProjects: null,
    features: null,
    sortOrder: 1,
    active: true,
  });

  logger.info("Subscription plans seeded");
}

async function upsertPlan(
  db: Db,
  plan: typeof subscriptionPlans.$inferInsert,
): Promise<void> {
  const existing = await db
    .select({ id: subscriptionPlans.id })
    .from(subscriptionPlans)
    .where(eq(subscriptionPlans.id, plan.id))
    .then((rows) => rows[0] ?? null);

  if (existing) {
    await db
      .update(subscriptionPlans)
      .set({
        name: plan.name,
        monthlyPriceCents: plan.monthlyPriceCents,
        stripePriceId: plan.stripePriceId,
        maxAgents: plan.maxAgents,
        maxCompanies: plan.maxCompanies,
        maxMonthlyCostCents: plan.maxMonthlyCostCents,
        maxStorageBytes: plan.maxStorageBytes,
        maxIssues: plan.maxIssues,
        maxProjects: plan.maxProjects,
        features: plan.features,
        sortOrder: plan.sortOrder,
        active: plan.active,
        updatedAt: new Date(),
      })
      .where(eq(subscriptionPlans.id, plan.id));
  } else {
    await db.insert(subscriptionPlans).values(plan);
  }
}
