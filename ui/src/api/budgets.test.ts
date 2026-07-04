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

    const result = await applyCloudCompanyBudget("company-1", 2000, true, "/costs");

    expect(result).toBe("updated");
    expect(mockApi.post).toHaveBeenCalledWith("/cloud-billing/budget", {
      companyId: "company-1",
      amountCents: 2000,
    });
    expect(assignSpy).not.toHaveBeenCalled();
  });

  it("starts a checkout with the return path and redirects for a first-time set (no budget subscription)", async () => {
    mockApi.post.mockResolvedValue({ checkoutUrl: "https://checkout.example/x" });

    const result = await applyCloudCompanyBudget("company-1", 2000, false, "/costs");

    expect(result).toBe("checkout");
    expect(mockApi.post).toHaveBeenCalledWith("/cloud-billing/checkout", {
      kind: "budget",
      companyId: "company-1",
      amountCents: 2000,
      returnTo: "/costs",
    });
    expect(assignSpy).toHaveBeenCalledWith("https://checkout.example/x");
  });

  // Money-safety: if the client thinks a subscription exists (stale/loading flag)
  // but the control plane says it does not (typed 409 no_budget_subscription), fall
  // back to CHECKOUT to create it, instead of surfacing "budget update failed". A
  // wrong "checkout" for a company that DOES have a subscription would double-bill,
  // so update-then-fallback is the safe direction (the 409 fires only when there is
  // genuinely no subscription).
  it("falls back to checkout when an update hits the typed no_budget_subscription 409", async () => {
    mockApi.post.mockReset();
    mockApi.post
      .mockRejectedValueOnce(
        new ApiError("no budget subscription; start one via checkout", 409, {
          error: "no budget subscription; start one via checkout",
          code: "no_budget_subscription",
        }),
      )
      .mockResolvedValueOnce({ checkoutUrl: "https://checkout.example/y" });

    const result = await applyCloudCompanyBudget("company-1", 2000, true, "/costs");

    expect(result).toBe("checkout");
    expect(mockApi.post).toHaveBeenNthCalledWith(1, "/cloud-billing/budget", {
      companyId: "company-1",
      amountCents: 2000,
    });
    expect(mockApi.post).toHaveBeenNthCalledWith(2, "/cloud-billing/checkout", {
      kind: "budget",
      companyId: "company-1",
      amountCents: 2000,
      returnTo: "/costs",
    });
    expect(assignSpy).toHaveBeenCalledWith("https://checkout.example/y");
  });

  it("does NOT swallow other update errors (a 502 still surfaces)", async () => {
    mockApi.post.mockReset();
    mockApi.post.mockRejectedValueOnce(new ApiError("budget update failed", 502, { error: "budget update failed" }));

    await expect(applyCloudCompanyBudget("company-1", 2000, true, "/costs")).rejects.toThrow(/budget update failed/);
  });
});
