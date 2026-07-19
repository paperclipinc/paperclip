// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { CompanySwitcher } from "./CompanySwitcher";

const navigateMock = vi.hoisted(() => vi.fn());
const createCloudCompanyMock = vi.hoisted(() => vi.fn());
const healthGetMock = vi.hoisted(() => vi.fn());
const setSelectedCompanyIdMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", () => ({
  useNavigate: () => navigateMock,
  // The "Manage Companies" / "Company Settings" items render a Link; stub it.
  Link: ({ children, ...props }: { children: ReactNode }) => <a {...props}>{children}</a>,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [{ id: "company-1", name: "Acme", status: "active" }],
    selectedCompany: { id: "company-1", name: "Acme", status: "active" },
    setSelectedCompanyId: setSelectedCompanyIdMock,
  }),
}));

vi.mock("@/api/health", () => ({
  healthApi: { get: () => healthGetMock() },
}));

vi.mock("@/api/cloudCompanies", () => ({
  cloudCompaniesApi: { create: (data: { name: string }) => createCloudCompanyMock(data) },
}));

// Render the dropdown primitives plainly so menu items are visible/clickable in
// jsdom without Radix portals. DropdownMenuItem forwards onSelect to a click.
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuItem: ({
    children,
    onClick,
    onSelect,
  }: {
    children: ReactNode;
    onClick?: () => void;
    onSelect?: (e: { preventDefault: () => void }) => void;
  }) => (
    <button
      type="button"
      onClick={() => {
        onClick?.();
        onSelect?.({ preventDefault: () => {} });
      }}
    >
      {children}
    </button>
  ),
}));

// Render the dialog only when open, children inline.
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function renderSwitcher(container: HTMLElement) {
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { root, queryClient };
}

function findButton(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === text,
  ) as HTMLButtonElement | undefined;
}

describe("CompanySwitcher — cloud create company", () => {
  let container: HTMLDivElement;
  let locationAssignMock: ReturnType<typeof vi.fn>;
  let originalLocation: Location;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    healthGetMock.mockResolvedValue({ status: "ok", deploymentMode: "authenticated" });
    locationAssignMock = vi.fn();
    originalLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { ...originalLocation, assign: locationAssignMock } as unknown as Location,
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: originalLocation,
    });
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("in cloud mode: Create company -> dialog -> submit calls the cloud endpoint and navigates", async () => {
    createCloudCompanyMock.mockResolvedValue({
      productSlug: "PC1A2B",
      url: "/PC1A2B/dashboard",
      name: "NewCo",
    });

    const { root, queryClient } = renderSwitcher(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanySwitcher />
        </QueryClientProvider>,
      );
    });
    await flushReact(); // resolve the health query -> isCloud

    // The cloud-only menu item is present.
    const createItem = findButton(container, "Create company");
    expect(createItem).toBeTruthy();

    await act(async () => {
      createItem!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    // The dialog opened.
    expect(container.querySelector('[role="dialog"]')).toBeTruthy();
    expect(container.textContent).toContain("Create company");

    // Type a name.
    const input = container.querySelector("input[aria-label='Company name']") as HTMLInputElement;
    expect(input).toBeTruthy();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input, "NewCo");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flushReact();

    // Submit via the footer button INSIDE the dialog (the menu item with the same
    // label lives outside the dialog).
    const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
    const submit = Array.from(dialog.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Create company" && !b.disabled,
    ) as HTMLButtonElement;
    await act(async () => {
      submit.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    expect(createCloudCompanyMock).toHaveBeenCalledWith({ name: "NewCo" });
    expect(locationAssignMock).toHaveBeenCalledWith("/PC1A2B/dashboard");

    await act(async () => root.unmount());
  });

  it("on 402 upgrade_required: shows the inline upgrade prompt and does not navigate", async () => {
    createCloudCompanyMock.mockRejectedValue(
      new ApiError("upgrade_required", 402, { error: "upgrade_required", capability: "create_company" }),
    );

    const { root, queryClient } = renderSwitcher(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanySwitcher />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    await act(async () => {
      findButton(container, "Create company")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const input = container.querySelector("input[aria-label='Company name']") as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input, "NewCo");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flushReact();

    const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
    const submit = Array.from(dialog.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Create company" && !b.disabled,
    ) as HTMLButtonElement;
    await act(async () => {
      submit.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Add another company");
    const accountLink = Array.from(container.querySelectorAll("a")).find(
      (a) => a.getAttribute("href") === "/account",
    );
    expect(accountLink).toBeTruthy();
    expect(locationAssignMock).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });

  it("in local (non-cloud) mode: the Create company item is hidden", async () => {
    healthGetMock.mockResolvedValue({ status: "ok", deploymentMode: "local_trusted" });

    const { root, queryClient } = renderSwitcher(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanySwitcher />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(findButton(container, "Create company")).toBeUndefined();
    // The native "Manage Companies" affordance is still there.
    expect(container.textContent).toContain("Manage Companies");

    await act(async () => root.unmount());
  });
});
