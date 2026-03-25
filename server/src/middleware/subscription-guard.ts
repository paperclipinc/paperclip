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
    .select({ status: companySubscriptions.status })
    .from(companySubscriptions)
    .where(eq(companySubscriptions.companyId, companyId))
    .then((rows) => rows[0]);

  if (!sub) return; // No subscription record = free tier, allowed
  if (sub.status === "active" || sub.status === "trialing" || sub.status === "free") return;
  if (sub.status === "past_due") return; // Grace period — allow but could warn

  throw Object.assign(new Error("Subscription is not active. Please update your billing."), {
    statusCode: 402,
    code: "SUBSCRIPTION_INACTIVE",
  });
}
