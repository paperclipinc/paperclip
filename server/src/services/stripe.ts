import Stripe from "stripe";
import { eq, and, asc } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companySubscriptions, subscriptionPlans, companies } from "@paperclipai/db";
import type { SubscriptionPlan, CompanySubscription } from "@paperclipai/shared";

let _stripe: Stripe | null = null;

function getStripe(): Stripe | null {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) return null;
  _stripe = new Stripe(key);
  return _stripe;
}

function parseFeatures(raw: string | null): Record<string, boolean> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, boolean>;
  } catch {
    return {};
  }
}

function toPlanDto(row: typeof subscriptionPlans.$inferSelect): SubscriptionPlan {
  return {
    id: row.id,
    name: row.name,
    monthlyPriceCents: row.monthlyPriceCents,
    maxAgents: row.maxAgents,
    maxCompanies: row.maxCompanies,
    maxMonthlyCostCents: row.maxMonthlyCostCents,
    features: parseFeatures(row.features),
    sortOrder: row.sortOrder,
  };
}

export function stripeService(db: Db) {
  return {
    isConfigured(): boolean {
      return !!process.env.STRIPE_SECRET_KEY?.trim();
    },

    async listPlans(): Promise<SubscriptionPlan[]> {
      const rows = await db
        .select()
        .from(subscriptionPlans)
        .where(eq(subscriptionPlans.active, true))
        .orderBy(asc(subscriptionPlans.sortOrder));
      return rows.map(toPlanDto);
    },

    async getSubscription(companyId: string): Promise<CompanySubscription | null> {
      const rows = await db
        .select({
          sub: companySubscriptions,
          plan: subscriptionPlans,
        })
        .from(companySubscriptions)
        .innerJoin(subscriptionPlans, eq(companySubscriptions.planId, subscriptionPlans.id))
        .where(eq(companySubscriptions.companyId, companyId));

      const row = rows[0];
      if (!row) return null;

      return {
        id: row.sub.id,
        companyId: row.sub.companyId,
        planId: row.sub.planId,
        plan: toPlanDto(row.plan),
        status: row.sub.status as CompanySubscription["status"],
        currentPeriodStart: row.sub.currentPeriodStart?.toISOString() ?? null,
        currentPeriodEnd: row.sub.currentPeriodEnd?.toISOString() ?? null,
        cancelAtPeriodEnd: row.sub.cancelAtPeriodEnd,
      };
    },

    async getOrCreateCustomer(companyId: string, companyName: string): Promise<string> {
      const existing = await db
        .select({ stripeCustomerId: companySubscriptions.stripeCustomerId })
        .from(companySubscriptions)
        .where(eq(companySubscriptions.companyId, companyId))
        .then((rows) => rows[0] ?? null);

      if (existing?.stripeCustomerId) {
        return existing.stripeCustomerId;
      }

      const stripe = getStripe();
      if (!stripe) throw new Error("Stripe is not configured");

      const customer = await stripe.customers.create({ name: companyName });

      // Upsert into company_subscriptions
      const existingRow = await db
        .select({ id: companySubscriptions.id })
        .from(companySubscriptions)
        .where(eq(companySubscriptions.companyId, companyId))
        .then((rows) => rows[0] ?? null);

      if (existingRow) {
        await db
          .update(companySubscriptions)
          .set({
            stripeCustomerId: customer.id,
            updatedAt: new Date(),
          })
          .where(eq(companySubscriptions.companyId, companyId));
      } else {
        // Get or create a default free plan
        const freePlan = await db
          .select()
          .from(subscriptionPlans)
          .where(eq(subscriptionPlans.id, "free"))
          .then((rows) => rows[0] ?? null);

        const planId = freePlan ? "free" : (await db
          .select({ id: subscriptionPlans.id })
          .from(subscriptionPlans)
          .orderBy(asc(subscriptionPlans.sortOrder))
          .then((rows) => rows[0]?.id ?? "free"));

        await db.insert(companySubscriptions).values({
          companyId,
          planId,
          stripeCustomerId: customer.id,
          status: "free",
        });
      }

      return customer.id;
    },

    async createCheckoutSession(
      companyId: string,
      planId: string,
      successUrl: string,
      cancelUrl: string,
    ): Promise<string> {
      const stripe = getStripe();
      if (!stripe) throw new Error("Stripe is not configured");

      const plan = await db
        .select()
        .from(subscriptionPlans)
        .where(and(eq(subscriptionPlans.id, planId), eq(subscriptionPlans.active, true)))
        .then((rows) => rows[0] ?? null);

      if (!plan || !plan.stripePriceId) {
        throw new Error("Plan not found or not available for purchase");
      }

      const company = await db
        .select()
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);

      if (!company) throw new Error("Company not found");

      const customerId = await this.getOrCreateCustomer(companyId, company.name);

      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        mode: "subscription",
        line_items: [{ price: plan.stripePriceId, quantity: 1 }],
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata: {
          companyId,
          planId,
        },
      });

      if (!session.url) throw new Error("Failed to create checkout session");
      return session.url;
    },

    async createPortalSession(companyId: string, returnUrl: string): Promise<string> {
      const stripe = getStripe();
      if (!stripe) throw new Error("Stripe is not configured");

      const sub = await db
        .select({ stripeCustomerId: companySubscriptions.stripeCustomerId })
        .from(companySubscriptions)
        .where(eq(companySubscriptions.companyId, companyId))
        .then((rows) => rows[0] ?? null);

      if (!sub?.stripeCustomerId) {
        throw new Error("No billing account found for this company");
      }

      const session = await stripe.billingPortal.sessions.create({
        customer: sub.stripeCustomerId,
        return_url: returnUrl,
      });

      return session.url;
    },

    async handleWebhookEvent(event: Stripe.Event): Promise<void> {
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object as Stripe.Checkout.Session;
          const companyId = session.metadata?.companyId;
          const planId = session.metadata?.planId;
          if (!companyId || !planId) break;

          const stripeSubscriptionId =
            typeof session.subscription === "string"
              ? session.subscription
              : session.subscription?.id ?? null;

          await db
            .update(companySubscriptions)
            .set({
              planId,
              stripeSubscriptionId,
              status: "active",
              updatedAt: new Date(),
            })
            .where(eq(companySubscriptions.companyId, companyId));
          break;
        }

        case "customer.subscription.updated": {
          const sub = event.data.object as Stripe.Subscription;
          const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;

          await db
            .update(companySubscriptions)
            .set({
              status: sub.status === "active" ? "active"
                : sub.status === "past_due" ? "past_due"
                : sub.status === "trialing" ? "trialing"
                : sub.status === "canceled" ? "canceled"
                : sub.status,
              currentPeriodStart: new Date(sub.current_period_start * 1000),
              currentPeriodEnd: new Date(sub.current_period_end * 1000),
              cancelAtPeriodEnd: sub.cancel_at_period_end,
              updatedAt: new Date(),
            })
            .where(eq(companySubscriptions.stripeCustomerId, customerId));
          break;
        }

        case "customer.subscription.deleted": {
          const sub = event.data.object as Stripe.Subscription;
          const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;

          // Find a free plan to revert to
          const freePlan = await db
            .select({ id: subscriptionPlans.id })
            .from(subscriptionPlans)
            .where(eq(subscriptionPlans.id, "free"))
            .then((rows) => rows[0] ?? null);

          await db
            .update(companySubscriptions)
            .set({
              planId: freePlan?.id ?? "free",
              status: "canceled",
              stripeSubscriptionId: null,
              cancelAtPeriodEnd: false,
              updatedAt: new Date(),
            })
            .where(eq(companySubscriptions.stripeCustomerId, customerId));
          break;
        }

        case "invoice.payment_failed": {
          const invoice = event.data.object as Stripe.Invoice;
          const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
          if (!customerId) break;

          await db
            .update(companySubscriptions)
            .set({
              status: "past_due",
              updatedAt: new Date(),
            })
            .where(eq(companySubscriptions.stripeCustomerId, customerId));
          break;
        }

        case "invoice.paid": {
          const invoice = event.data.object as Stripe.Invoice;
          const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
          if (!customerId) break;

          await db
            .update(companySubscriptions)
            .set({
              status: "active",
              updatedAt: new Date(),
            })
            .where(eq(companySubscriptions.stripeCustomerId, customerId));
          break;
        }
      }
    },
  };
}
