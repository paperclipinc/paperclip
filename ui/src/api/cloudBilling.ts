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
}

export const cloudBillingApi = {
  summary: () => api.get<CloudBillingSummary>("/cloud-billing/summary"),
};
