// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewCompanyDialog } from "./NewCompanyDialog";
import { ApiError } from "@/api/client";

const mockCloudCompaniesApi = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@/api/cloudCompanies", () => ({ cloudCompaniesApi: mockCloudCompaniesApi }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function renderDialog(onOpenChange = vi.fn()) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return { container, root, queryClient, onOpenChange };
}

describe("NewCompanyDialog", () => {
  let assignSpy: ReturnType<typeof vi.fn>;
  let originalLocation: Location;

  beforeEach(() => {
    assignSpy = vi.fn();
    originalLocation = window.location;
    // jsdom's window.location (and its .assign) is non-configurable, so replace
    // the whole object with a stub to assert the full-page navigation (the whole
    // point of this dialog).
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
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("does a FULL-PAGE navigation (not client-side) to the new company on success", async () => {
    mockCloudCompaniesApi.create.mockResolvedValue({
      productSlug: "PCnewco",
      url: "/PCnewco/dashboard",
      name: "New Co",
    });
    const { container, root, queryClient, onOpenChange } = renderDialog();

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <NewCompanyDialog open onOpenChange={onOpenChange} />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    const input = document.body.querySelector('input[aria-label="Company name"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      setter?.call(input, "New Co");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flushReact();

    const createButton = Array.from(document.body.querySelectorAll("button")).find(
      (b) => b.textContent === "Create company",
    );
    expect(createButton).toBeTruthy();
    await act(async () => {
      createButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockCloudCompaniesApi.create).toHaveBeenCalledWith({ name: "New Co" });
    // Full-page navigation, NOT a client-side router push: only window.location
    // .assign forces a fresh gateway request for the new slug so the gateway
    // injects the new company's stack and the product auto-creates membership.
    expect(assignSpy).toHaveBeenCalledWith("/PCnewco/dashboard");
    expect(onOpenChange).toHaveBeenCalledWith(false);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("shows the inline upgrade prompt on a 402 and does NOT navigate", async () => {
    mockCloudCompaniesApi.create.mockRejectedValue(
      new ApiError("upgrade_required", 402, { error: "upgrade_required" }),
    );
    const { container, root, queryClient, onOpenChange } = renderDialog();

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <NewCompanyDialog open onOpenChange={onOpenChange} />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    const input = document.body.querySelector('input[aria-label="Company name"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      setter?.call(input, "New Co");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flushReact();

    const createButton = Array.from(document.body.querySelectorAll("button")).find(
      (b) => b.textContent === "Create company",
    );
    await act(async () => {
      createButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(document.body.textContent).toContain("Creating more companies is a Pro feature");
    expect(assignSpy).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("shows the billing-failure message (not the upgrade prompt) on a 402 billing_update_failed", async () => {
    // An already-paying user whose per-company base-quantity bump failed at the
    // billing provider gets a 402 too; that is a billing error, not a plan gate.
    mockCloudCompaniesApi.create.mockRejectedValue(
      new ApiError("billing_update_failed", 402, { error: "billing_update_failed" }),
    );
    const { container, root, queryClient, onOpenChange } = renderDialog();

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <NewCompanyDialog open onOpenChange={onOpenChange} />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    const input = document.body.querySelector('input[aria-label="Company name"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      setter?.call(input, "New Co");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flushReact();

    const createButton = Array.from(document.body.querySelectorAll("button")).find(
      (b) => b.textContent === "Create company",
    );
    await act(async () => {
      createButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(document.body.textContent).toContain(
      "We could not update your billing for the new company.",
    );
    expect(document.body.textContent).toContain("you have not been charged");
    expect(document.body.textContent).not.toContain("Creating more companies is a Pro feature");
    expect(assignSpy).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("shows the inline limit message on a 409 and does NOT navigate", async () => {
    mockCloudCompaniesApi.create.mockRejectedValue(
      new ApiError("company_limit_reached", 409, { error: "company_limit_reached" }),
    );
    const { container, root, queryClient, onOpenChange } = renderDialog();

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <NewCompanyDialog open onOpenChange={onOpenChange} />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    const input = document.body.querySelector('input[aria-label="Company name"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      setter?.call(input, "New Co");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flushReact();

    const createButton = Array.from(document.body.querySelectorAll("button")).find(
      (b) => b.textContent === "Create company",
    );
    await act(async () => {
      createButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(document.body.textContent).toContain("reached your plan's company limit");
    expect(assignSpy).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
