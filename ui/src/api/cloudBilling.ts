import { api } from "./client";

// Cloud-only (the `cloudBilling` instance flag): the gateway proxies
// /api/cloud-billing/* to the hosting control plane for the signed-in account.
// Self-hosted instances never call this.
export interface CloudBillingSummary {
  plan: string | null;
  status: string | null;
  // Derived at read time: a trialing sub past trialEndsAt reads "trial_expired"
  // while `status` keeps the raw value.
  effectiveStatus?: string | null;
  trialEndsAt?: string | null;
  currentPeriodEnd?: string | null;
  entitlements?: unknown;
  // Per-company billing state. `hasBudgetSubscription` is the authoritative signal
  // for first-time-set vs change of the recurring budget wallet: a trial with
  // INCLUDED budget reads false (no subscription yet) so the first raise checks out.
  companies?: Array<{ companyId: string; slug?: string; hasBudgetSubscription: boolean }>;
}

export const cloudBillingApi = {
  summary: () => api.get<CloudBillingSummary>("/cloud-billing/summary"),
};
