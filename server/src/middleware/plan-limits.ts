import type { Db } from "@paperclipai/db";
import { companySubscriptions, subscriptionPlans, agents } from "@paperclipai/db";
import { eq, count } from "drizzle-orm";
import { forbidden } from "../errors.js";

export function planLimits(db: Db) {
  return {
    async checkAgentLimit(companyId: string): Promise<void> {
      let sub: { maxAgents: number | null } | null;
      try {
        sub = await db
          .select({ maxAgents: subscriptionPlans.maxAgents })
          .from(companySubscriptions)
          .innerJoin(subscriptionPlans, eq(companySubscriptions.planId, subscriptionPlans.id))
          .where(eq(companySubscriptions.companyId, companyId))
          .then((rows) => rows[0] ?? null);
      } catch {
        // Subscription tables may not exist yet (no migration applied).
        // Treat as no subscription = no enforced limits.
        return;
      }

      if (!sub) return; // No subscription = no enforced limits
      if (sub.maxAgents === null) return; // Unlimited

      const [agentCountRow] = await db
        .select({ count: count() })
        .from(agents)
        .where(eq(agents.companyId, companyId));

      const agentCount = Number(agentCountRow?.count ?? 0);

      if (agentCount >= sub.maxAgents) {
        throw forbidden(
          `Agent limit reached (${sub.maxAgents}) for your current plan. Upgrade to add more agents.`,
        );
      }
    },
  };
}
