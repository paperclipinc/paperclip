import type { SubscriptionPlan, CompanySubscription, AccountSubscription } from "@paperclipai/shared";
import { api } from "./client";

export type CompanyEligibility = {
  canCreateCompany: boolean;
  hasUnlimited?: boolean;
  reason?: string;
};

export const billingApi = {
  listPlans: () => api.get<SubscriptionPlan[]>("/billing/plans"),

  checkCompanyCreationEligibility: () =>
    api.get<CompanyEligibility>("/billing/company-creation-eligibility"),

  getSubscription: (companyId: string) =>
    api.get<CompanySubscription | null>(`/companies/${companyId}/subscription`),

  createCheckoutSession: (
    companyId: string,
    planId: string,
    options?: { successPath?: string; cancelPath?: string },
  ) =>
    api.post<{ url: string }>(`/companies/${companyId}/billing/checkout`, {
      planId,
      ...options,
    }),

  createPortalSession: (companyId: string) =>
    api.post<{ url: string }>(`/companies/${companyId}/billing/portal`, {}),

  getAccountSubscription: () =>
    api.get<AccountSubscription | null>("/billing/account-subscription"),

  createAccountCheckoutSession: (
    planId: string,
    options?: { successPath?: string; cancelPath?: string },
  ) =>
    api.post<{ url: string }>("/billing/account/checkout", { planId, ...options }),

  createAccountPortalSession: () =>
    api.post<{ url: string }>("/billing/account/portal", {}),
};
