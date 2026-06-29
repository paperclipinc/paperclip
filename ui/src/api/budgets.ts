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
  // Cloud-only: when the `cloudBilling` instance flag is on, the company budget is
  // a recurring monthly wallet funded through the hosted checkout (Paddle). Unused
  // balance carries over month to month. Self-hosters leave the flag off and write
  // the limit directly via `upsertPolicy`.
  //
  // First-time set: create the recurring budget subscription and redirect to
  // checkout to collect the first charge + set up monthly billing. `returnTo` is
  // the same-origin path the buyer should land back on after checkout (their Costs
  // page), so a refill no longer bounces them to the account page. The control
  // plane validates it and falls back to /account if missing or off-origin.
  setRecurringBudget: (companyId: string, amountCents: number, returnTo?: string) =>
    api.post<{ checkoutUrl: string }>("/cloud-billing/checkout", {
      kind: "budget",
      companyId,
      amountCents,
      ...(returnTo ? { returnTo } : {}),
    }),
  // Changing an existing budget: PATCH the recurring subscription's quantity
  // (prorated immediately). No checkout redirect.
  updateRecurringBudget: (companyId: string, amountCents: number) =>
    api.post<void>("/cloud-billing/budget", {
      companyId,
      amountCents,
    }),
};

// Decide whether raising the cloud budget is a first-time set (start a recurring
// budget subscription via checkout) or a change to an existing one (PATCH the
// subscription quantity). A company whose wallet already has a funded amount has
// a budget subscription, so a change updates it in place; otherwise we checkout.
export function resolveCloudBudgetAction(currentBudgetCents: number): "checkout" | "update" {
  return currentBudgetCents > 0 ? "update" : "checkout";
}
