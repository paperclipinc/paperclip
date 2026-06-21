import type {
  BudgetIncident,
  BudgetIncidentResolutionInput,
  BudgetOverview,
  BudgetPolicySummary,
  BudgetPolicyUpsertInput,
} from "@paperclipai/shared";
import { api } from "./client";

export const budgetsApi = {
  overview: (companyId: string) =>
    api.get<BudgetOverview>(`/companies/${companyId}/budgets/overview`),
  upsertPolicy: (companyId: string, data: BudgetPolicyUpsertInput) =>
    api.post<BudgetPolicySummary>(`/companies/${companyId}/budgets/policies`, data),
  resolveIncident: (companyId: string, incidentId: string, data: BudgetIncidentResolutionInput) =>
    api.post<BudgetIncident>(
      `/companies/${companyId}/budget-incidents/${encodeURIComponent(incidentId)}/resolve`,
      data,
    ),
  // Cloud-only: when the `cloudBilling` instance flag is on, a budget raise is
  // funded by a metered credit top-up that runs through the hosted checkout
  // (Vatly) instead of writing the limit directly. Self-hosters never call this.
  checkoutCreditTopup: (companyId: string, amountCents: number) =>
    api.post<{ checkoutUrl: string }>("/cloud-billing/checkout", {
      kind: "credit_topup",
      companyId,
      amountCents,
    }),
};
