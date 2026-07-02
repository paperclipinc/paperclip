import type { BudgetPolicySummary } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import {
  companyBudgetStatSubtitle,
  companyBudgetStatValue,
  describeCompanyBudgetForSpend,
  resolveCompanyBudgetDisplay,
} from "./company-budget-display";

function makePolicy(overrides: Partial<BudgetPolicySummary> = {}): BudgetPolicySummary {
  return {
    policyId: "policy-1",
    companyId: "company-1",
    scopeType: "company",
    scopeId: "company-1",
    scopeName: "Acme Labs",
    metric: "cost_cents",
    windowKind: "lifetime",
    amount: 100,
    observedAmount: 42,
    remainingAmount: 58,
    utilizationPercent: 42,
    warnPercent: 80,
    hardStopEnabled: true,
    notifyEnabled: true,
    isActive: true,
    status: "ok",
    paused: false,
    pauseReason: null,
    windowStart: new Date("2026-01-01T00:00:00.000Z"),
    windowEnd: new Date("2026-12-31T00:00:00.000Z"),
    ...overrides,
  } as BudgetPolicySummary;
}

const noMonthly = { budgetCents: 0, utilizationPercent: 0 };

describe("resolveCompanyBudgetDisplay", () => {
  it("prefers a lifetime company policy (the cloud wallet) over everything", () => {
    const lifetime = makePolicy();
    const display = resolveCompanyBudgetDisplay([lifetime], { budgetCents: 5000, utilizationPercent: 10 });
    expect(display).toEqual({ kind: "policy", policy: lifetime });
  });

  it("keeps the monthly company cap when no lifetime policy exists", () => {
    const display = resolveCompanyBudgetDisplay([], { budgetCents: 5000, utilizationPercent: 10 });
    expect(display).toEqual({ kind: "monthly", budgetCents: 5000, utilizationPercent: 10 });
  });

  it("falls back to a calendar-month company policy when the monthly cap is unset", () => {
    const calendar = makePolicy({ windowKind: "calendar_month_utc" });
    const display = resolveCompanyBudgetDisplay([calendar], noMonthly);
    expect(display).toEqual({ kind: "policy", policy: calendar });
  });

  it("is none only when NO company policy of any kind exists", () => {
    expect(resolveCompanyBudgetDisplay([], noMonthly)).toEqual({ kind: "none" });
    expect(resolveCompanyBudgetDisplay(undefined, noMonthly)).toEqual({ kind: "none" });
  });

  it("ignores inactive and zero-amount company policies", () => {
    expect(resolveCompanyBudgetDisplay([makePolicy({ isActive: false })], noMonthly)).toEqual({ kind: "none" });
    expect(resolveCompanyBudgetDisplay([makePolicy({ amount: 0 })], noMonthly)).toEqual({ kind: "none" });
  });

  it("ignores agent- and project-scope policies", () => {
    const policies = [
      makePolicy({ scopeType: "agent", scopeId: "agent-1" }),
      makePolicy({ scopeType: "project", scopeId: "project-1" }),
    ];
    expect(resolveCompanyBudgetDisplay(policies, noMonthly)).toEqual({ kind: "none" });
  });
});

describe("describeCompanyBudgetForSpend", () => {
  it("describes the lifetime wallet on the dashboard spend card", () => {
    const display = resolveCompanyBudgetDisplay([makePolicy()], noMonthly);
    expect(describeCompanyBudgetForSpend(display)).toBe("42% of $1.00 lifetime budget");
  });

  it("describes a calendar-month company policy as a monthly budget", () => {
    const display = resolveCompanyBudgetDisplay([makePolicy({ windowKind: "calendar_month_utc" })], noMonthly);
    expect(describeCompanyBudgetForSpend(display)).toBe("42% of $1.00 monthly budget");
  });

  it("keeps the existing monthly-cap phrasing byte-identical", () => {
    const display = resolveCompanyBudgetDisplay([], { budgetCents: 5000, utilizationPercent: 10 });
    expect(describeCompanyBudgetForSpend(display)).toBe("10% of $50.00 budget");
  });

  it("only says Unlimited budget when no policy of any kind exists", () => {
    expect(describeCompanyBudgetForSpend({ kind: "none" })).toBe("Unlimited budget");
  });
});

describe("companyBudgetStatValue", () => {
  it("shows policy utilization for a lifetime wallet", () => {
    const display = resolveCompanyBudgetDisplay([makePolicy()], noMonthly);
    expect(companyBudgetStatValue(display)).toBe("42%");
  });

  it("keeps the existing monthly utilization value", () => {
    const display = resolveCompanyBudgetDisplay([], { budgetCents: 5000, utilizationPercent: 10 });
    expect(companyBudgetStatValue(display)).toBe("10%");
  });

  it("only shows Open when no policy of any kind exists", () => {
    expect(companyBudgetStatValue({ kind: "none" })).toBe("Open");
  });
});

describe("companyBudgetStatSubtitle", () => {
  it("shows the lifetime wallet usage on the costs header", () => {
    const display = resolveCompanyBudgetDisplay([makePolicy()], noMonthly);
    expect(companyBudgetStatSubtitle(display, 0)).toBe("$0.42 of $1.00 lifetime budget");
  });

  it("keeps the existing monthly subtitle byte-identical", () => {
    const display = resolveCompanyBudgetDisplay([], { budgetCents: 5000, utilizationPercent: 10 });
    expect(companyBudgetStatSubtitle(display, 500)).toBe("$5.00 of $50.00");
  });

  it("only says no cap when no policy of any kind exists", () => {
    expect(companyBudgetStatSubtitle({ kind: "none" }, 0)).toBe("No monthly cap configured");
  });
});
