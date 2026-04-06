import Stripe from "stripe";
import { Resend } from "resend";
import { eq, and, asc } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  companySubscriptions,
  accountSubscriptions,
  subscriptionPlans,
  companies,
  companyMemberships,
  authUsers,
  agents,
} from "@paperclipai/db";
import type { SubscriptionPlan, CompanySubscription, AccountSubscription } from "@paperclipai/shared";

let _stripe: Stripe | null = null;

function getStripe(): Stripe | null {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) return null;
  _stripe = new Stripe(key);
  return _stripe;
}

/**
 * Send a billing-related notification email directly via Resend.
 * Self-contained so the webhook handler doesn't need the EmailSender wired in.
 */
async function sendBillingEmail(
  db: Db,
  stripeCustomerId: string,
  subject: string,
  body: string,
): Promise<void> {
  const resendApiKey = process.env.RESEND_API_KEY?.trim();
  if (!resendApiKey) {
    console.warn(`[stripe] Cannot send billing email: RESEND_API_KEY not set. Subject: ${subject}`);
    return;
  }

  try {
    // Look up the company subscription to find the companyId
    const subRow = await db
      .select({ companyId: companySubscriptions.companyId })
      .from(companySubscriptions)
      .where(eq(companySubscriptions.stripeCustomerId, stripeCustomerId))
      .then((rows) => rows[0] ?? null);

    if (!subRow) {
      console.warn(`[stripe] No subscription found for customer ${stripeCustomerId}, cannot send billing email`);
      return;
    }

    // Look up company name
    const company = await db
      .select({ name: companies.name })
      .from(companies)
      .where(eq(companies.id, subRow.companyId))
      .then((rows) => rows[0] ?? null);

    const companyName = company?.name ?? "your company";
    const publicUrl = process.env.PAPERCLIP_PUBLIC_URL?.trim() ?? "https://paperclip.inc";

    // Find active members of the company to email
    const members = await db
      .select({ email: authUsers.email })
      .from(companyMemberships)
      .innerJoin(authUsers, eq(companyMemberships.principalId, authUsers.id))
      .where(
        and(
          eq(companyMemberships.companyId, subRow.companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.status, "active"),
        ),
      );

    if (members.length === 0) {
      console.warn(`[stripe] No active members found for company ${subRow.companyId}, cannot send billing email`);
      return;
    }

    const emailFrom = process.env.PAPERCLIP_EMAIL_FROM?.trim() || "Paperclip <noreply@paperclip.inc>";
    const resend = new Resend(resendApiKey);

    // Interpolate company name and public URL into the body
    const interpolatedBody = body
      .replace(/\{companyName\}/g, companyName)
      .replace(/\{publicUrl\}/g, publicUrl);

    const recipientEmails = members.map((m) => m.email);

    await resend.emails.send({
      from: emailFrom,
      to: recipientEmails,
      subject,
      text: interpolatedBody,
    });

    console.info(`[stripe] Sent billing email "${subject}" to ${recipientEmails.length} recipient(s) for company ${subRow.companyId}`);
  } catch (err) {
    // Never let email failures break the webhook handler
    console.error(`[stripe] Failed to send billing email: ${err}`);
  }
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
    scope: row.scope as "company" | "account",
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
        trialEndsAt: row.sub.trialEndsAt?.toISOString() ?? null,
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

    async getAccountSubscription(userId: string): Promise<AccountSubscription | null> {
      const rows = await db
        .select({ sub: accountSubscriptions, plan: subscriptionPlans })
        .from(accountSubscriptions)
        .innerJoin(subscriptionPlans, eq(accountSubscriptions.planId, subscriptionPlans.id))
        .where(eq(accountSubscriptions.userId, userId));

      const row = rows[0];
      if (!row) return null;

      return {
        id: row.sub.id,
        userId: row.sub.userId,
        planId: row.sub.planId,
        plan: toPlanDto(row.plan),
        status: row.sub.status as AccountSubscription["status"],
        currentPeriodStart: row.sub.currentPeriodStart?.toISOString() ?? null,
        currentPeriodEnd: row.sub.currentPeriodEnd?.toISOString() ?? null,
        cancelAtPeriodEnd: row.sub.cancelAtPeriodEnd,
      };
    },

    async getOrCreateAccountCustomer(userId: string, userName: string, userEmail: string): Promise<string> {
      const existing = await db
        .select({ stripeCustomerId: accountSubscriptions.stripeCustomerId })
        .from(accountSubscriptions)
        .where(eq(accountSubscriptions.userId, userId))
        .then((rows) => rows[0] ?? null);

      if (existing?.stripeCustomerId) return existing.stripeCustomerId;

      const stripe = getStripe();
      if (!stripe) throw new Error("Stripe is not configured");

      const customer = await stripe.customers.create({ name: userName, email: userEmail });

      const existingRow = await db
        .select({ id: accountSubscriptions.id })
        .from(accountSubscriptions)
        .where(eq(accountSubscriptions.userId, userId))
        .then((rows) => rows[0] ?? null);

      if (existingRow) {
        await db
          .update(accountSubscriptions)
          .set({ stripeCustomerId: customer.id, updatedAt: new Date() })
          .where(eq(accountSubscriptions.userId, userId));
      } else {
        await db.insert(accountSubscriptions).values({
          userId,
          planId: "unlimited",
          stripeCustomerId: customer.id,
          status: "free",
        });
      }

      return customer.id;
    },

    async createAccountCheckoutSession(
      userId: string,
      planId: string,
      successUrl: string,
      cancelUrl: string,
    ): Promise<string> {
      const stripe = getStripe();
      if (!stripe) throw new Error("Stripe is not configured");

      const plan = await db
        .select()
        .from(subscriptionPlans)
        .where(and(eq(subscriptionPlans.id, planId), eq(subscriptionPlans.active, true), eq(subscriptionPlans.scope, "account")))
        .then((rows) => rows[0] ?? null);

      if (!plan || !plan.stripePriceId) {
        throw new Error("Plan not found or not available for purchase");
      }

      const user = await db
        .select({ name: authUsers.name, email: authUsers.email })
        .from(authUsers)
        .where(eq(authUsers.id, userId))
        .then((rows) => rows[0] ?? null);

      if (!user) throw new Error("User not found");

      const customerId = await this.getOrCreateAccountCustomer(userId, user.name, user.email);

      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        mode: "subscription",
        line_items: [{ price: plan.stripePriceId, quantity: 1 }],
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata: {
          userId,
          planId,
          subscriptionScope: "account",
        },
      });

      if (!session.url) throw new Error("Failed to create checkout session");
      return session.url;
    },

    async createAccountPortalSession(userId: string, returnUrl: string): Promise<string> {
      const stripe = getStripe();
      if (!stripe) throw new Error("Stripe is not configured");

      const sub = await db
        .select({ stripeCustomerId: accountSubscriptions.stripeCustomerId })
        .from(accountSubscriptions)
        .where(eq(accountSubscriptions.userId, userId))
        .then((rows) => rows[0] ?? null);

      if (!sub?.stripeCustomerId) {
        throw new Error("No account billing found");
      }

      const session = await stripe.billingPortal.sessions.create({
        customer: sub.stripeCustomerId,
        return_url: returnUrl,
      });

      return session.url;
    },

    async upgradeToUnlimited(userId: string): Promise<void> {
      const stripe = getStripe();

      // Find all companies where this user is a member
      const memberCompanies = await db
        .select({ companyId: companyMemberships.companyId })
        .from(companyMemberships)
        .where(and(eq(companyMemberships.principalId, userId), eq(companyMemberships.principalType, "user")));

      for (const { companyId } of memberCompanies) {
        const sub = await db
          .select({
            stripeSubscriptionId: companySubscriptions.stripeSubscriptionId,
            status: companySubscriptions.status,
          })
          .from(companySubscriptions)
          .where(eq(companySubscriptions.companyId, companyId))
          .then((rows) => rows[0] ?? null);

        if (!sub) continue;

        // Cancel active Stripe subscription with proration
        if (sub.stripeSubscriptionId && stripe && sub.status !== "canceled" && sub.status !== "covered_by_account") {
          try {
            await stripe.subscriptions.cancel(sub.stripeSubscriptionId, { prorate: true });
          } catch (err) {
            console.warn(`[stripe] Failed to cancel company subscription for ${companyId}: ${err}`);
          }
        }

        // Mark company subscription as covered by account
        await db
          .update(companySubscriptions)
          .set({
            status: "covered_by_account",
            stripeSubscriptionId: null,
            updatedAt: new Date(),
          })
          .where(eq(companySubscriptions.companyId, companyId));

        // Resume any system-paused agents in this company
        await resumeSystemPausedAgents(db, companyId);
      }

      console.info(`[stripe] Upgraded user ${userId} to Unlimited, covered ${memberCompanies.length} company/companies`);
    },

    async handleWebhookEvent(event: Stripe.Event): Promise<void> {
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object as Stripe.Checkout.Session;
          const subscriptionScope = session.metadata?.subscriptionScope;

          if (subscriptionScope === "account") {
            // Account-level checkout (Unlimited plan)
            const userId = session.metadata?.userId;
            const planId = session.metadata?.planId;
            if (!userId || !planId) break;

            const stripeSubscriptionId =
              typeof session.subscription === "string"
                ? session.subscription
                : session.subscription?.id ?? null;

            await db
              .update(accountSubscriptions)
              .set({
                planId,
                stripeSubscriptionId,
                status: "active",
                updatedAt: new Date(),
              })
              .where(eq(accountSubscriptions.userId, userId));

            // Cancel individual company subscriptions
            await this.upgradeToUnlimited(userId);
          } else {
            // Company-level checkout (Pro plan)
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
                trialEndsAt: null,
                updatedAt: new Date(),
              })
              .where(eq(companySubscriptions.companyId, companyId));

            await resumeSystemPausedAgents(db, companyId);
          }
          break;
        }

        case "customer.subscription.updated": {
          const sub = event.data.object as Stripe.Subscription;
          const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;

          // Check if this is an account-level subscription
          const accountSubUpdated = await db
            .select({ userId: accountSubscriptions.userId })
            .from(accountSubscriptions)
            .where(eq(accountSubscriptions.stripeCustomerId, customerId))
            .then((rows) => rows[0] ?? null);

          if (accountSubUpdated) {
            // Update account subscription instead
            await db
              .update(accountSubscriptions)
              .set({
                status: sub.status === "active" ? "active"
                  : sub.status === "past_due" ? "past_due"
                  : sub.status === "canceled" ? "canceled"
                  : sub.status,
                currentPeriodStart: new Date(sub.current_period_start * 1000),
                currentPeriodEnd: new Date(sub.current_period_end * 1000),
                cancelAtPeriodEnd: sub.cancel_at_period_end,
                updatedAt: new Date(),
              })
              .where(eq(accountSubscriptions.stripeCustomerId, customerId));
            break;
          }

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

          // Check if this is an account-level subscription
          const accountSubDeleted = await db
            .select({ userId: accountSubscriptions.userId })
            .from(accountSubscriptions)
            .where(eq(accountSubscriptions.stripeCustomerId, customerId))
            .then((rows) => rows[0] ?? null);

          if (accountSubDeleted) {
            // Update account subscription
            await db
              .update(accountSubscriptions)
              .set({
                status: "canceled",
                stripeSubscriptionId: null,
                cancelAtPeriodEnd: false,
                updatedAt: new Date(),
              })
              .where(eq(accountSubscriptions.stripeCustomerId, customerId));

            // Revert all covered companies back to trial_expired
            const coveredCompanies = await db
              .select({ companyId: companyMemberships.companyId })
              .from(companyMemberships)
              .where(and(eq(companyMemberships.principalId, accountSubDeleted.userId), eq(companyMemberships.principalType, "user")));

            for (const { companyId } of coveredCompanies) {
              await db
                .update(companySubscriptions)
                .set({
                  status: "trial_expired",
                  updatedAt: new Date(),
                })
                .where(and(eq(companySubscriptions.companyId, companyId), eq(companySubscriptions.status, "covered_by_account")));
            }
            break;
          }

          // Keep the current plan (don't revert to "free" in cloud mode)
          // so the user can easily resubscribe from the billing page.
          await db
            .update(companySubscriptions)
            .set({
              status: "canceled",
              stripeSubscriptionId: null,
              cancelAtPeriodEnd: false,
              updatedAt: new Date(),
            })
            .where(eq(companySubscriptions.stripeCustomerId, customerId));

          await sendBillingEmail(
            db,
            customerId,
            "Your Paperclip subscription has been canceled",
            "Your subscription for {companyName} has been canceled and your account has been reverted to the free plan.\n\nIf this was a mistake, you can resubscribe at {publicUrl}/billing.\n\nIf you have any questions, please reach out to our support team.",
          );
          break;
        }

        case "invoice.payment_failed": {
          const invoice = event.data.object as Stripe.Invoice;
          const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
          if (!customerId) break;

          // Check if this is an account-level subscription
          const accountSubFailed = await db
            .select({ userId: accountSubscriptions.userId })
            .from(accountSubscriptions)
            .where(eq(accountSubscriptions.stripeCustomerId, customerId))
            .then((rows) => rows[0] ?? null);

          if (accountSubFailed) {
            // Update account subscription instead
            await db
              .update(accountSubscriptions)
              .set({
                status: "past_due",
                updatedAt: new Date(),
              })
              .where(eq(accountSubscriptions.stripeCustomerId, customerId));
            break;
          }

          await db
            .update(companySubscriptions)
            .set({
              status: "past_due",
              updatedAt: new Date(),
            })
            .where(eq(companySubscriptions.stripeCustomerId, customerId));

          await sendBillingEmail(
            db,
            customerId,
            "Payment failed for your Paperclip subscription",
            "We couldn't process your payment for {companyName}. Please update your billing information at {publicUrl}/billing.\n\nIf payment continues to fail, your subscription may be canceled.",
          );
          break;
        }

        case "invoice.paid": {
          const invoice = event.data.object as Stripe.Invoice;
          const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
          if (!customerId) break;

          // Check if this is an account-level subscription
          const accountSubPaid = await db
            .select({ userId: accountSubscriptions.userId })
            .from(accountSubscriptions)
            .where(eq(accountSubscriptions.stripeCustomerId, customerId))
            .then((rows) => rows[0] ?? null);

          if (accountSubPaid) {
            // Update account subscription instead
            await db
              .update(accountSubscriptions)
              .set({
                status: "active",
                updatedAt: new Date(),
              })
              .where(eq(accountSubscriptions.stripeCustomerId, customerId));

            // Resume agents in ALL companies the user is a member of
            const memberCompanies = await db
              .select({ companyId: companyMemberships.companyId })
              .from(companyMemberships)
              .where(and(eq(companyMemberships.principalId, accountSubPaid.userId), eq(companyMemberships.principalType, "user")));

            for (const { companyId } of memberCompanies) {
              await resumeSystemPausedAgents(db, companyId);
            }
            break;
          }

          await db
            .update(companySubscriptions)
            .set({
              status: "active",
              updatedAt: new Date(),
            })
            .where(eq(companySubscriptions.stripeCustomerId, customerId));

          // Resume agents if they were paused due to subscription issues
          const subRow = await db
            .select({ companyId: companySubscriptions.companyId })
            .from(companySubscriptions)
            .where(eq(companySubscriptions.stripeCustomerId, customerId))
            .then((rows) => rows[0] ?? null);
          if (subRow) {
            await resumeSystemPausedAgents(db, subRow.companyId);
          }
          break;
        }
      }
    },
  };
}

/**
 * Resume agents that were paused by the system due to subscription expiry.
 * Only resumes agents with pauseReason "system" to avoid unpausing
 * manually paused or budget-paused agents.
 */
async function resumeSystemPausedAgents(db: Db, companyId: string): Promise<void> {
  const resumed = await db
    .update(agents)
    .set({
      status: "idle",
      pauseReason: null,
      pausedAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(agents.companyId, companyId),
        eq(agents.status, "paused"),
        eq(agents.pauseReason, "system"),
      ),
    )
    .returning({ id: agents.id });

  if (resumed.length > 0) {
    console.info(
      `[stripe] Resumed ${resumed.length} system-paused agent(s) for company ${companyId}`,
    );
  }
}
