// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock("./client", () => ({
  api: mockApi,
  // Mirror the real ApiError so instanceof checks in budgets.ts match the errors
  // the tests throw (the module under test imports ApiError from this same mock).
  ApiError: class ApiError extends Error {
    status: number;
    body: unknown;
    constructor(message: string, status: number, body: unknown) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.body = body;
    }
  },
}));

import { ApiError } from "./client";
import { applyCloudCompanyBudget, budgetsApi, resolveCloudBudgetAction } from "./budgets";

describe("budgetsApi recurring carry-over budget", () => {
  beforeEach(() => {
    mockApi.post.mockReset();
    mockApi.post.mockResolvedValue({ checkoutUrl: "https://checkout.example/x" });
  });

  it("setRecurringBudget starts a recurring budget subscription via checkout", async () => {
    await budgetsApi.setRecurringBudget("company-1", 10000);
    expect(mockApi.post).toHaveBeenCalledWith("/cloud-billing/checkout", {
      kind: "budget",
      companyId: "company-1",
      amountCents: 10000,
    });
  });

  it("updateRecurringBudget PATCHes the existing budget subscription (no checkout)", async () => {
    await budgetsApi.updateRecurringBudget("company-1", 15000);
    expect(mockApi.post).toHaveBeenCalledWith("/cloud-billing/budget", {
      companyId: "company-1",
      amountCents: 15000,
    });
  });

  it("no longer exposes the one-time credit top-up affordance", () => {
    expect((budgetsApi as Record<string, unknown>).checkoutCreditTopup).toBeUndefined();
  });
});

describe("resolveCloudBudgetAction", () => {
  // The action is decided by whether a REAL recurring budget subscription exists,
  // not the wallet amount. A Pro trial carries EUR 1 of INCLUDED budget (wallet > 0)
  // but has no budget subscription, so the first raise MUST go through checkout to
  // create it: routing it to "update" hits a subscription that does not exist and
  // the billing provider throws ("budget update failed").
  it("checks out for a first-time set when there is no budget subscription (incl. a funded trial wallet)", () => {
    expect(resolveCloudBudgetAction(false)).toBe("checkout");
  });

  it("updates the subscription when a budget subscription already exists", () => {
    expect(resolveCloudBudgetAction(true)).toBe("update");
  });
});

// The single cloud company-budget flow shared by the Costs page policy save and
// the budget incident card: update the existing recurring budget in place, or
// start a checkout (with a same-origin return path) for a first-time set.
describe("applyCloudCompanyBudget", () => {
  let assignSpy: ReturnType<typeof vi.fn>;
  let originalLocation: Location;

  beforeEach(() => {
    mockApi.post.mockReset();
    assignSpy = vi.fn();
    originalLocation = window.location;
    // jsdom's window.location (and its .assign) is non-configurable, so replace
    // the whole object with a stub to assert the checkout redirect.
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { ...originalLocation, assign: assignSpy } as unknown as Location,
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: originalLocation,
    });
  });

  it("updates the existing recurring budget in place when a budget subscription exists", async () => {
    mockApi.post.mockResolvedValue(undefined);

    const result = await applyCloudCompanyBudget("company-1", 2000, true);

    expect(result).toBe("updated");
    expect(mockApi.post).toHaveBeenCalledWith("/cloud-billing/budget", {
      companyId: "company-1",
      amountCents: 2000,
    });
    expect(assignSpy).not.toHaveBeenCalled();
  });

  it("routes a first-time set (no budget subscription, e.g. a trial) to the plan-upgrade page, NOT a bare budget checkout", async () => {
    mockApi.post.mockResolvedValue(undefined);

    const result = await applyCloudCompanyBudget("company-1", 2000, false);

    // A first-time budget purchase legally needs the EU withdrawal-consent gate,
    // which only the hosted /account checkout collects; the bare budget checkout
    // API is rejected consent_required. So a trial is pushed to upgrade a plan.
    expect(result).toBe("checkout");
    expect(assignSpy).toHaveBeenCalledWith("/account");
    // Must NOT hit the budget checkout endpoint (that dead-ends at consent_required).
    expect(mockApi.post).not.toHaveBeenCalledWith("/cloud-billing/checkout", expect.anything());
  });

  // Money-safety: if the client thinks a subscription exists (stale/loading flag)
  // but the control plane says it does not (typed 409 no_budget_subscription), the
  // company has no recurring budget, so route to the plan-upgrade page rather than
  // surfacing "budget update failed". A wrong "checkout"/redirect for a company that
  // DOES have a subscription would be worse, so update-then-fallback is the safe
  // direction (the 409 fires only when there is genuinely no subscription).
  it("routes to plan upgrade when an update hits the typed no_budget_subscription 409", async () => {
    mockApi.post.mockReset();
    mockApi.post.mockRejectedValueOnce(
      new ApiError("no budget subscription; start one via checkout", 409, {
        error: "no budget subscription; start one via checkout",
        code: "no_budget_subscription",
      }),
    );

    const result = await applyCloudCompanyBudget("company-1", 2000, true);

    expect(result).toBe("checkout");
    expect(mockApi.post).toHaveBeenNthCalledWith(1, "/cloud-billing/budget", {
      companyId: "company-1",
      amountCents: 2000,
    });
    // No second call to the bare budget checkout endpoint; we redirect to /account.
    expect(mockApi.post).toHaveBeenCalledTimes(1);
    expect(assignSpy).toHaveBeenCalledWith("/account");
  });

  it("does NOT swallow other update errors (a 502 still surfaces)", async () => {
    mockApi.post.mockReset();
    mockApi.post.mockRejectedValueOnce(new ApiError("budget update failed", 502, { error: "budget update failed" }));

    await expect(applyCloudCompanyBudget("company-1", 2000, true)).rejects.toThrow(/budget update failed/);
  });
});
