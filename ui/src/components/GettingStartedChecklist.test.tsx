// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockActivationApi = vi.hoisted(() => ({ statusForCompany: vi.fn() }));
const mockAccessApi = vi.hoisted(() => ({ listUserDirectory: vi.fn() }));
const mockInboxDismissalsApi = vi.hoisted(() => ({
  list: vi.fn(),
  dismiss: vi.fn(),
}));
vi.mock("@/api/activation", () => ({ activationApi: mockActivationApi }));
vi.mock("@/api/access", () => ({ accessApi: mockAccessApi }));
vi.mock("@/api/inboxDismissals", () => ({
  inboxDismissalsApi: mockInboxDismissalsApi,
}));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children: unknown }) => (
    <a href={to}>{children as never}</a>
  ),
}));

import { GettingStartedChecklist } from "./GettingStartedChecklist";

async function flushReact() {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
  flushSync(() => {});
}

describe("GettingStartedChecklist", () => {
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockActivationApi.statusForCompany.mockResolvedValue({ activated: false });
    mockAccessApi.listUserDirectory.mockResolvedValue({
      users: [{ principalId: "u1" }],
    });
    mockInboxDismissalsApi.list.mockResolvedValue([]);
    mockInboxDismissalsApi.dismiss.mockResolvedValue({});
  });
  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function render(props: {
    companyId: string;
    hasAgents: boolean;
    hasIssues: boolean;
  }) {
    const root = createRoot(container);
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    flushSync(() =>
      root.render(
        <QueryClientProvider client={qc}>
          <GettingStartedChecklist
            companyId={props.companyId}
            hasAgents={props.hasAgents}
            hasIssues={props.hasIssues}
            onHireAgent={() => {}}
          />
        </QueryClientProvider>,
      ),
    );
    await flushReact();
    return root;
  }

  it("marks 'Hire your first agent' done when hasAgents is true", async () => {
    const root = await render({
      companyId: "c1",
      hasAgents: true,
      hasIssues: false,
    });
    const hireRow = [...container.querySelectorAll("li")].find((li) =>
      li.textContent?.includes("Hire your first agent"),
    )!;
    expect(hireRow.getAttribute("data-done")).toBe("true");
    flushSync(() => root.unmount());
  });

  it("marks 'Run your first task' incomplete when hasIssues is false", async () => {
    const root = await render({
      companyId: "c1",
      hasAgents: true,
      hasIssues: false,
    });
    const taskRow = [...container.querySelectorAll("li")].find((li) =>
      li.textContent?.includes("Run your first task"),
    )!;
    expect(taskRow.getAttribute("data-done")).toBe("false");
    flushSync(() => root.unmount());
  });

  it("renders nothing once already dismissed", async () => {
    mockInboxDismissalsApi.list.mockResolvedValue([
      { itemKey: "checklist:getting-started" },
    ]);
    const root = await render({
      companyId: "c1",
      hasAgents: true,
      hasIssues: true,
    });
    expect(container.textContent).not.toContain("Getting started");
    flushSync(() => root.unmount());
  });

  it("self-dismisses (calls dismiss) once every item is done", async () => {
    mockActivationApi.statusForCompany.mockResolvedValue({ activated: true });
    mockAccessApi.listUserDirectory.mockResolvedValue({
      users: [{ principalId: "u1" }, { principalId: "u2" }],
    });
    const root = await render({
      companyId: "c1",
      hasAgents: true,
      hasIssues: true,
    });
    await flushReact();
    expect(mockInboxDismissalsApi.dismiss).toHaveBeenCalledWith(
      "c1",
      "checklist:getting-started",
    );
    flushSync(() => root.unmount());
  });
});
