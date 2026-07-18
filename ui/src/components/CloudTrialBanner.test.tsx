// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCurrentBoardAccess } from "@/test-utils/currentBoardAccess";
import { CloudTrialBanner, trialDaysLeft } from "./CloudTrialBanner";

const mockAccessApi = vi.hoisted(() => ({
  getCurrentBoardAccess: vi.fn(),
}));
const mockCloudBillingApi = vi.hoisted(() => ({
  summary: vi.fn(),
}));

vi.mock("@/api/access", () => ({
  accessApi: mockAccessApi,
}));
vi.mock("@/api/cloudBilling", () => ({
  cloudBillingApi: mockCloudBillingApi,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-07-02T09:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function inDays(days: number): string {
  // Slightly inside the window so Math.ceil lands exactly on `days`.
  return new Date(Date.now() + days * DAY_MS - 1000).toISOString();
}

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;
let queryClient: QueryClient | null = null;

function experimental(cloudTrialBanner: boolean) {
  return buildCurrentBoardAccess({ features: { cloudTrialBanner } });
}

function trialingSummary(trialEndsAt: string) {
  return {
    plan: "pro",
    status: "trialing",
    effectiveStatus: "trialing",
    trialEndsAt,
    entitlements: {},
  };
}

async function render(client?: QueryClient) {
  queryClient = client ?? new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <QueryClientProvider client={queryClient!}>
        <CloudTrialBanner />
      </QueryClientProvider>,
    );
  });
  // The summary query only becomes enabled once the experimental-settings query
  // resolves (and react-query notifies through a macrotask), so flush a few rounds.
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
  return container;
}

beforeEach(() => {
  window.sessionStorage.clear();
  mockAccessApi.getCurrentBoardAccess.mockResolvedValue(experimental(true));
  mockCloudBillingApi.summary.mockResolvedValue(trialingSummary(inDays(5)));
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  queryClient?.clear();
  queryClient = null;
  vi.clearAllMocks();
});

describe("trialDaysLeft", () => {
  it("counts whole days remaining, rounding up", () => {
    expect(trialDaysLeft("2026-07-07T09:00:00.000Z", NOW.getTime())).toBe(5);
    expect(trialDaysLeft("2026-07-02T21:00:00.000Z", NOW.getTime())).toBe(1);
  });

  it("never goes below zero and tolerates junk", () => {
    expect(trialDaysLeft("2026-07-01T09:00:00.000Z", NOW.getTime())).toBe(0);
    expect(trialDaysLeft(null, NOW.getTime())).toBe(null);
    expect(trialDaysLeft("not-a-date", NOW.getTime())).toBe(null);
  });
});

describe("CloudTrialBanner", () => {
  it("shows the trial banner with days left and a subscribe-now link", async () => {
    const node = await render();
    expect(node.textContent).toContain("Your free trial ends in 5 days.");
    // Flat-plan cleanup: the stale usage-budget language must be gone.
    expect(node.textContent).not.toContain("usage budget");
    const link = [...node.querySelectorAll("a")].find((a) => a.textContent?.includes("Subscribe now"));
    expect(link?.getAttribute("href")).toBe("/account");
  });

  it("uses the singular form for the last day", async () => {
    mockCloudBillingApi.summary.mockResolvedValue(trialingSummary(inDays(1)));
    const node = await render();
    expect(node.textContent).toContain("Your free trial ends in 1 day.");
  });

  it("says 'ends today' on the final day rather than 'in 0 days'", async () => {
    mockCloudBillingApi.summary.mockResolvedValue(trialingSummary(inDays(0)));
    const node = await render();
    expect(node.textContent).toContain("Your free trial ends today.");
    expect(node.textContent).not.toContain("0 days");
  });

  it("shows the trial-ended banner when the trial expired", async () => {
    mockCloudBillingApi.summary.mockResolvedValue({
      plan: "pro",
      status: "trialing",
      effectiveStatus: "trial_expired",
      trialEndsAt: "2026-06-25T09:00:00.000Z",
      entitlements: {},
    });
    const node = await render();
    expect(node.textContent).toContain("Your free trial has ended.");
    const link = [...node.querySelectorAll("a")].find((a) => a.textContent?.includes("Subscribe now"));
    expect(link?.getAttribute("href")).toBe("/account");
  });

  it("renders nothing for an active subscription", async () => {
    mockCloudBillingApi.summary.mockResolvedValue({
      plan: "pro",
      status: "active",
      effectiveStatus: "active",
      trialEndsAt: null,
      entitlements: {},
    });
    const node = await render();
    expect(node.textContent).toBe("");
  });

  it("renders nothing and never fetches billing off-cloud", async () => {
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue(experimental(false));
    const node = await render();
    expect(node.textContent).toBe("");
    expect(mockCloudBillingApi.summary).not.toHaveBeenCalled();
  });

  it("fails silent when the summary fetch errors", async () => {
    mockCloudBillingApi.summary.mockRejectedValue(new Error("gateway sneezed"));
    const node = await render();
    expect(node.textContent).toBe("");
  });

  it("dismisses for the session", async () => {
    const node = await render();
    const dismiss = [...node.querySelectorAll("button")].find(
      (button) => button.getAttribute("aria-label") === "Dismiss",
    );
    expect(dismiss).toBeTruthy();
    await act(async () => {
      dismiss?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(node.textContent).toBe("");

    // A remount in the same session stays dismissed.
    act(() => root?.unmount());
    root = null;
    container?.remove();
    const remounted = await render();
    expect(remounted.textContent).toBe("");
  });

  it("fetches the summary once per page load", async () => {
    await render();
    expect(mockCloudBillingApi.summary).toHaveBeenCalledTimes(1);

    act(() => root?.unmount());
    root = null;
    container?.remove();
    await render(queryClient!);
    expect(mockCloudBillingApi.summary).toHaveBeenCalledTimes(1);
  });
});
