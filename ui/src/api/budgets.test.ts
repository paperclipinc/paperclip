// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock("./client", () => ({
  api: mockApi,
}));

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
  it("checks out for a first-time set (no funded budget yet)", () => {
    expect(resolveCloudBudgetAction(0)).toBe("checkout");
  });

  it("updates the subscription when a budget already exists", () => {
    expect(resolveCloudBudgetAction(10000)).toBe("update");
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

  it("updates the existing recurring budget in place when the wallet is already funded", async () => {
    mockApi.post.mockResolvedValue(undefined);

    const result = await applyCloudCompanyBudget("company-1", 2000, 10000, "/costs");

    expect(result).toBe("updated");
    expect(mockApi.post).toHaveBeenCalledWith("/cloud-billing/budget", {
      companyId: "company-1",
      amountCents: 2000,
    });
    expect(assignSpy).not.toHaveBeenCalled();
  });

  it("starts a checkout with the return path and redirects for a first-time set", async () => {
    mockApi.post.mockResolvedValue({ checkoutUrl: "https://checkout.example/x" });

    const result = await applyCloudCompanyBudget("company-1", 2000, 0, "/costs");

    expect(result).toBe("checkout");
    expect(mockApi.post).toHaveBeenCalledWith("/cloud-billing/checkout", {
      kind: "budget",
      companyId: "company-1",
      amountCents: 2000,
      returnTo: "/costs",
    });
    expect(assignSpy).toHaveBeenCalledWith("https://checkout.example/x");
  });
});
