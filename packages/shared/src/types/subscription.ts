export interface SubscriptionPlan {
  id: string;
  name: string;
  monthlyPriceCents: number;
  maxAgents: number | null;
  maxCompanies: number | null;
  maxMonthlyCostCents: number | null;
  features: Record<string, boolean>;
  sortOrder: number;
}

export interface CompanySubscription {
  id: string;
  companyId: string;
  planId: string;
  plan: SubscriptionPlan;
  status: "active" | "past_due" | "canceled" | "trialing" | "free" | "trial_expired";
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  trialEndsAt: string | null;
}
