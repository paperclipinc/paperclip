import type { SubscriptionPlan, CompanySubscription } from "@paperclipai/shared";
import { api } from "./client";

export const billingApi = {
  listPlans: () => api.get<SubscriptionPlan[]>("/billing/plans"),
  getSubscription: (companyId: string) =>
    api.get<CompanySubscription | null>(`/companies/${companyId}/subscription`),
  createCheckoutSession: (companyId: string, planId: string) =>
    api.post<{ url: string }>(`/companies/${companyId}/billing/checkout`, { planId }),
  createPortalSession: (companyId: string) =>
    api.post<{ url: string }>(`/companies/${companyId}/billing/portal`, {}),
};
