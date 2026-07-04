import type {
  BudgetIncident,
  BudgetIncidentResolutionInput,
  BudgetOverview,
  BudgetPolicySummary,
  BudgetPolicyUpsertInput,
} from "@paperclipai/shared";
import { ApiError, api } from "./client";

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
// subscription quantity). The signal is whether a REAL recurring budget
// subscription exists, NOT the wallet amount: a Pro trial carries EUR 1 of
// INCLUDED budget (wallet > 0) yet has no budget subscription, so its first raise
// must go through checkout to create the subscription. Deciding from the wallet
// amount routed the trial to "update", which then failed against a non-existent
// subscription ("budget update failed").
export function resolveCloudBudgetAction(hasBudgetSubscription: boolean): "checkout" | "update" {
  return hasBudgetSubscription ? "update" : "checkout";
}

// The single cloud company-budget flow (shared by the Costs page policy save and
// the budget incident card): update the existing recurring budget in place, or
// start a checkout for a first-time set and redirect to it. `returnTo` is the
// same-origin path the buyer lands back on after checkout. Returns "checkout"
// when the browser is navigating away so callers can skip local refreshes.
export async function applyCloudCompanyBudget(
  companyId: string,
  amountCents: number,
  hasBudgetSubscription: boolean,
  returnTo?: string,
): Promise<"updated" | "checkout"> {
  if (resolveCloudBudgetAction(hasBudgetSubscription) === "update") {
    try {
      await budgetsApi.updateRecurringBudget(companyId, amountCents);
      return "updated";
    } catch (err) {
      // Money-safety fallback: if the flag was stale/loading and the company has NO
      // recurring budget subscription, the control plane returns a typed 409
      // (no_budget_subscription) instead of a real charge. Create the subscription
      // via checkout rather than surfacing a generic failure. Any other error
      // (e.g. a 502 provider failure) propagates unchanged.
      if (!isNoBudgetSubscription(err)) throw err;
    }
  }
  const { checkoutUrl } = await budgetsApi.setRecurringBudget(companyId, amountCents, returnTo);
  window.location.assign(checkoutUrl);
  return "checkout";
}

// A typed "this company has no recurring budget subscription; create one via
// checkout" signal from the control plane (POST /cloud-billing/budget).
function isNoBudgetSubscription(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    err.status === 409 &&
    (err.body as { code?: string } | null)?.code === "no_budget_subscription"
  );
}
