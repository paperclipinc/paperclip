// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentConfigForm } from "./AgentConfigForm";
import { defaultCreateValues } from "./agent-config-defaults";
import type { CreateConfigValues } from "./AgentConfigForm";
import { TooltipProvider } from "@/components/ui/tooltip";

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getExperimental: vi.fn(),
  getGeneral: vi.fn(),
}));

const mockAgentsApi = vi.hoisted(() => ({
  adapterModels: vi.fn(),
  detectModel: vi.fn(),
  adapterModelProfiles: vi.fn(),
  list: vi.fn(),
  testEnvironment: vi.fn(),
}));

const mockEnvironmentsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockSecretsApi = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn() }));
const mockAssetsApi = vi.hoisted(() => ({ uploadImage: vi.fn() }));
const mockAdaptersApi = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock("../api/instanceSettings", () => ({ instanceSettingsApi: mockInstanceSettingsApi }));
vi.mock("../api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("../api/environments", () => ({ environmentsApi: mockEnvironmentsApi }));
vi.mock("../api/secrets", () => ({ secretsApi: mockSecretsApi }));
vi.mock("../api/assets", () => ({ assetsApi: mockAssetsApi }));
vi.mock("@/api/adapters", () => ({ adaptersApi: mockAdaptersApi }));

// MarkdownEditor pulls @mdxeditor/editor -> @codesandbox/sandpack -> stitches,
// which fails to evaluate its CSS under jsdom. Stub it; this test does not
// exercise markdown editing.
vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: () => null,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Paperclip" },
  }),
}));

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

describe("AgentConfigForm — managed experience", () => {
  let container: HTMLDivElement;

  async function renderCreateForm() {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const values: CreateConfigValues = { ...defaultCreateValues };
    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <AgentConfigForm
              mode="create"
              values={values}
              onChange={() => {}}
            />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    return root;
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockInstanceSettingsApi.getGeneral.mockResolvedValue({});
    mockAgentsApi.adapterModels.mockResolvedValue([]);
    mockAgentsApi.detectModel.mockResolvedValue({ model: null, candidates: [] });
    mockAgentsApi.adapterModelProfiles.mockResolvedValue([]);
    mockAgentsApi.list.mockResolvedValue([]);
    mockEnvironmentsApi.list.mockResolvedValue([]);
    mockSecretsApi.list.mockResolvedValue([]);
    mockAdaptersApi.list.mockResolvedValue([]);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("managed ON: folds the Adapter type field behind the Advanced disclosure", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ managedExperience: true });
    const root = await renderCreateForm();

    // The disclosure header is present...
    expect(container.textContent).toContain("Advanced: runtime & model");
    // ...but the harness picker label is hidden until it is opened.
    expect(container.textContent).not.toContain("Adapter type");

    // Open the disclosure.
    const toggle = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Advanced: runtime & model"),
    );
    expect(toggle).toBeTruthy();
    flushSync(() => {
      toggle!.click();
    });
    await flushReact();

    expect(container.textContent).toContain("Adapter type");

    flushSync(() => {
      root.unmount();
    });
  });

  it("managed OFF: shows the Adapter type field directly (no Advanced disclosure)", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ managedExperience: false });
    const root = await renderCreateForm();

    expect(container.textContent).toContain("Adapter type");
    expect(container.textContent).not.toContain("Advanced: runtime & model");

    flushSync(() => {
      root.unmount();
    });
  });
});
