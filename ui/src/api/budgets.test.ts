import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock("./client", () => ({
  api: mockApi,
}));

import { budgetsApi, resolveCloudBudgetAction } from "./budgets";

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
