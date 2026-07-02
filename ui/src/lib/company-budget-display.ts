import type { BudgetPolicySummary } from "@paperclipai/shared";
import { formatCents } from "./utils";

// What the Dashboard "Month Spend" card and the Costs header "Budget" tile
// should say about the COMPANY budget. Both surfaces used to read only the
// monthly cap (company.budgetMonthlyCents), so a company capped by a LIFETIME
// policy (the cloud wallet) showed "Unlimited budget" / "Open - no cap" while
// the Budgets tab showed the wallet. "Unlimited" may only appear when no
// company policy of any kind exists.
export type CompanyBudgetDisplay =
  | { kind: "policy"; policy: BudgetPolicySummary }
  | { kind: "monthly"; budgetCents: number; utilizationPercent: number }
  | { kind: "none" };

export function resolveCompanyBudgetDisplay(
  policies: BudgetPolicySummary[] | undefined,
  monthly: { budgetCents: number; utilizationPercent: number },
): CompanyBudgetDisplay {
  const companyPolicies = (policies ?? []).filter(
    (policy) => policy.scopeType === "company" && policy.isActive && policy.amount > 0,
  );
  const lifetime = companyPolicies.find((policy) => policy.windowKind === "lifetime");
  if (lifetime) return { kind: "policy", policy: lifetime };
  // No lifetime wallet: the monthly cap keeps its existing rendering.
  if (monthly.budgetCents > 0) {
    return { kind: "monthly", budgetCents: monthly.budgetCents, utilizationPercent: monthly.utilizationPercent };
  }
  const calendar = companyPolicies[0];
  if (calendar) return { kind: "policy", policy: calendar };
  return { kind: "none" };
}

function budgetWindowNoun(windowKind: BudgetPolicySummary["windowKind"]): string {
  return windowKind === "lifetime" ? "lifetime budget" : "monthly budget";
}

/** Description under the Dashboard "Month Spend" metric. */
export function describeCompanyBudgetForSpend(display: CompanyBudgetDisplay): string {
  if (display.kind === "policy") {
    return `${display.policy.utilizationPercent}% of ${formatCents(display.policy.amount)} ${budgetWindowNoun(display.policy.windowKind)}`;
  }
  if (display.kind === "monthly") {
    return `${display.utilizationPercent}% of ${formatCents(display.budgetCents)} budget`;
  }
  return "Unlimited budget";
}

/** Value of the Costs header "Budget" tile (when no incident is active). */
export function companyBudgetStatValue(display: CompanyBudgetDisplay): string {
  if (display.kind === "policy") return `${display.policy.utilizationPercent}%`;
  if (display.kind === "monthly") return `${display.utilizationPercent}%`;
  return "Open";
}

/** Subtitle of the Costs header "Budget" tile (when no incident is active). */
export function companyBudgetStatSubtitle(display: CompanyBudgetDisplay, monthSpendCents: number): string {
  if (display.kind === "policy") {
    return `${formatCents(display.policy.observedAmount)} of ${formatCents(display.policy.amount)} ${budgetWindowNoun(display.policy.windowKind)}`;
  }
  if (display.kind === "monthly") {
    return `${formatCents(monthSpendCents)} of ${formatCents(display.budgetCents)}`;
  }
  return "No monthly cap configured";
}
