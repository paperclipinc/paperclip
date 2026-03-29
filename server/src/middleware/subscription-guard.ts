import { eq } from "drizzle-orm";
import type { RequestHandler } from "express";
import type { Db } from "@paperclipai/db";
import { companySubscriptions } from "@paperclipai/db";

export function subscriptionGuard(db: Db): RequestHandler {
  return async (req, _res, next) => {
    // Skip for non-board actors (agents, local_implicit)
    if (req.actor.type !== "board" || req.actor.source === "local_implicit") {
      next();
      return;
    }
    // Attach subscription status to request for downstream checks
    // Don't block here — let individual routes decide enforcement
    next();
  };
}

export async function assertActiveSubscription(db: Db, companyId: string): Promise<void> {
  const sub = await db
    .select({
      status: companySubscriptions.status,
      trialEndsAt: companySubscriptions.trialEndsAt,
    })
    .from(companySubscriptions)
    .where(eq(companySubscriptions.companyId, companyId))
    .then((rows) => rows[0]);

  if (!sub) return; // No subscription record = self-hosted free tier, allowed
  if (sub.status === "active" || sub.status === "free") return;
  if (sub.status === "past_due") return; // Grace period — allow but could warn

  if (sub.status === "trialing") {
    if (sub.trialEndsAt && new Date(sub.trialEndsAt) > new Date()) return; // Trial still active

    // Trial expired — update status lazily and block
    await db
      .update(companySubscriptions)
      .set({ status: "trial_expired", updatedAt: new Date() })
      .where(eq(companySubscriptions.companyId, companyId));

    throw Object.assign(
      new Error("Your 14-day free trial has ended. Please subscribe to continue."),
      { statusCode: 402, code: "TRIAL_EXPIRED" },
    );
  }

  if (sub.status === "trial_expired") {
    throw Object.assign(
      new Error("Your 14-day free trial has ended. Please subscribe to continue."),
      { statusCode: 402, code: "TRIAL_EXPIRED" },
    );
  }

  if (sub.status === "canceled") {
    throw Object.assign(
      new Error("Your subscription has been canceled. Please resubscribe to continue."),
      { statusCode: 402, code: "SUBSCRIPTION_CANCELED" },
    );
  }

  throw Object.assign(new Error("Subscription is not active. Please update your billing."), {
    statusCode: 402,
    code: "SUBSCRIPTION_INACTIVE",
  });
}
