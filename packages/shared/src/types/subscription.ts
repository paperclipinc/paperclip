export interface SubscriptionPlan {
  id: string;
  name: string;
  monthlyPriceCents: number;
  maxAgents: number | null;
  maxCompanies: number | null;
  maxMonthlyCostCents: number | null;
  features: Record<string, boolean>;
  sortOrder: number;
  scope: "company" | "account";
}

export interface CompanySubscription {
  id: string;
  companyId: string;
  planId: string;
  plan: SubscriptionPlan;
  status: "active" | "past_due" | "canceled" | "trialing" | "free" | "trial_expired" | "covered_by_account";
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  trialEndsAt: string | null;
}

export interface AccountSubscription {
  id: string;
  userId: string;
  planId: string;
  plan: SubscriptionPlan;
  status: "active" | "past_due" | "canceled" | "free";
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}
