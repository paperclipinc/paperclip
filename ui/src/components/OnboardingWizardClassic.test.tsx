// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));

const mockAdaptersApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockAgentsApi = vi.hoisted(() => ({
  adapterModels: vi.fn(),
}));

// Open the classic wizard directly on Step 2 ("Create your first agent") for an
// existing company so the adapter/model pickers render without driving through
// the earlier company-creation step.
vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({
    onboardingOpen: true,
    onboardingOptions: { initialStep: 2, companyId: "company-1" },
    closeOnboarding: vi.fn(),
  }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [{ id: "company-1", issuePrefix: "PAP", name: "Acme" }],
    setSelectedCompanyId: vi.fn(),
    loading: false,
  }),
}));

vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: "/" }),
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("@/api/adapters", () => ({
  adaptersApi: mockAdaptersApi,
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

// Peripheral visuals — render nothing; they are irrelevant to the gating.
vi.mock("./AsciiArtAnimation", () => ({ AsciiArtAnimation: () => null }));

import { OnboardingWizardClassic } from "./OnboardingWizardClassic";

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

describe("OnboardingWizardClassic managed experience", () => {
  let container: HTMLDivElement;

  async function renderWizard() {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <OnboardingWizardClassic />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    return root;
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    localStorage.clear();
    mockAdaptersApi.list.mockResolvedValue([]);
    mockAgentsApi.adapterModels.mockResolvedValue([]);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    localStorage.clear();
    vi.clearAllMocks();
  });

  it("hides the Adapter type picker when managedExperience is on", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ managedExperience: true });
    const root = await renderWizard();

    expect(document.body.textContent).not.toContain("Adapter type");

    flushSync(() => {
      root.unmount();
    });
  });

  it("shows the Adapter type picker when managedExperience is off", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ managedExperience: false });
    const root = await renderWizard();

    expect(document.body.textContent).toContain("Adapter type");

    flushSync(() => {
      root.unmount();
    });
  });
});
