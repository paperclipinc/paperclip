// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks (hoisted so vi.mock factories can close over them) ----------------

const ONBOARDING_STORAGE_KEY = "paperclip-onboarding-state";

const mockDialog = vi.hoisted(() => ({
  onboardingOpen: true,
  onboardingOptions: {} as { initialStep?: number; companyId?: string },
  closeOnboarding: vi.fn(),
  onboardingRouteDismissed: false,
  setOnboardingRouteDismissed: vi.fn(),
}));

const mockCompany = vi.hoisted(() => ({
  companies: [] as Array<{ id: string; name: string; issuePrefix: string }>,
  setSelectedCompanyId: vi.fn(),
  loading: false,
}));

const mockCompaniesApi = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
}));
const mockGoalsApi = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(),
}));
const mockInstanceSettingsApi = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));

vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: "/", search: "", hash: "", state: null }),
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
}));
vi.mock("../context/DialogContext", () => ({
  useDialog: () => mockDialog,
}));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => mockCompany,
}));
vi.mock("../api/companies", () => ({ companiesApi: mockCompaniesApi }));
vi.mock("../api/goals", () => ({ goalsApi: mockGoalsApi }));
vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));
// The real adapter registry eagerly imports every adapter package (incl. the
// hermes adapter, which is not built in this workspace). The model/harness
// picker is out of scope here, so stub the adapter layer entirely.
vi.mock("../adapters", () => ({
  listUIAdapters: () => [],
  getUIAdapter: () => ({ buildAdapterConfig: () => ({}) }),
}));
vi.mock("../adapters/metadata", () => ({ isVisualAdapterChoice: () => true }));
vi.mock("../adapters/adapter-display-registry", () => ({
  getAdapterDisplay: (type: string) => ({
    type,
    recommended: false,
    label: type,
    description: "",
    icon: () => null,
  }),
}));
vi.mock("../adapters/use-disabled-adapters", () => ({
  useDisabledAdaptersSync: () => new Set<string>(),
}));
vi.mock("../adapters/use-adapter-capabilities", () => ({
  useAdapterCapabilities: () => () => ({
    supportsInstructionsBundle: false,
    supportsSkills: false,
    supportsLocalAgentJwt: false,
    requiresMaterializedRuntimeSkills: false,
    supportsModelProfiles: false,
  }),
}));
// Animation / canvas-ish children that add nothing to the logic under test.
vi.mock("./AsciiArtAnimation", () => ({ AsciiArtAnimation: () => null }));
vi.mock("./FrontDoor", () => ({ FrontDoor: () => null }));
vi.mock("./AgentCapsule", () => ({ AgentCapsule: () => null }));

import { OnboardingWizard } from "./OnboardingWizard";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function render() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return { container, root, queryClient };
}

async function mount() {
  const { container, root, queryClient } = render();
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <OnboardingWizard />
      </QueryClientProvider>,
    );
  });
  await flushReact();
  return { container, root };
}

function findButton(text: string): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").includes(text),
  ) as HTMLButtonElement | undefined;
}

describe("OnboardingWizard cloud first-run", () => {
  beforeEach(() => {
    window.localStorage.clear();
    mockDialog.onboardingOpen = true;
    mockDialog.onboardingOptions = {};
    mockDialog.onboardingRouteDismissed = false;
    mockCompany.companies = [];
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({});
    mockCompaniesApi.create.mockResolvedValue({
      id: "created",
      name: "Created Co",
      issuePrefix: "CRE",
    });
    mockCompaniesApi.update.mockResolvedValue({
      id: "c1",
      name: "Acme Rockets",
      issuePrefix: "PAP",
    });
    mockGoalsApi.create.mockResolvedValue({ id: "goal-1" });
    mockGoalsApi.list.mockResolvedValue([]);
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("lands on the company-name step with an empty input", async () => {
    mockDialog.onboardingOptions = { initialStep: 1, companyId: "c1" };
    mockCompany.companies = [{ id: "c1", name: "Auto Co", issuePrefix: "PAP" }];

    const { root } = await mount();

    const input = document.body.querySelector(
      'input[placeholder="Name your company"]',
    ) as HTMLInputElement | null;
    expect(input).not.toBeNull();
    // The auto-generated company name must NOT be pre-filled — the user names
    // it fresh.
    expect(input!.value).toBe("");

    await act(async () => {
      root.unmount();
    });
  });

  it("renames the existing company instead of creating it (cloud rename path)", async () => {
    // Seed a step-2 state with a typed name + mission for an already-existing
    // (auto-created) company.
    window.localStorage.setItem(
      ONBOARDING_STORAGE_KEY,
      JSON.stringify({
        step: 2,
        companyName: "Acme Rockets",
        companyGoal: "Win the launch",
        missionPath: "direct",
        createdCompanyId: "c1",
      }),
    );
    mockDialog.onboardingOptions = { initialStep: 2, companyId: "c1" };
    mockCompany.companies = [{ id: "c1", name: "Auto Co", issuePrefix: "PAP" }];

    const { root } = await mount();

    const confirm = findButton("Confirm mission");
    expect(confirm).toBeTruthy();
    await act(async () => {
      confirm!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockCompaniesApi.update).toHaveBeenCalledWith("c1", {
      name: "Acme Rockets",
    });
    expect(mockCompaniesApi.create).not.toHaveBeenCalled();
    // The company goal is still created on the rename path.
    expect(mockGoalsApi.create).toHaveBeenCalledTimes(1);
    expect(mockGoalsApi.create.mock.calls[0][0]).toBe("c1");
    expect(mockGoalsApi.create.mock.calls[0][1]).toMatchObject({
      level: "company",
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("creates a new company in the non-cloud first-run path (OSS unchanged)", async () => {
    window.localStorage.setItem(
      ONBOARDING_STORAGE_KEY,
      JSON.stringify({
        step: 2,
        companyName: "Fresh Co",
        companyGoal: "Ship it",
        missionPath: "direct",
      }),
    );
    // No companyId → no existing company → the create branch must run.
    mockDialog.onboardingOptions = {};
    mockCompany.companies = [];

    const { root } = await mount();

    const confirm = findButton("Confirm mission");
    expect(confirm).toBeTruthy();
    await act(async () => {
      confirm!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockCompaniesApi.create).toHaveBeenCalledWith({ name: "Fresh Co" });
    expect(mockCompaniesApi.update).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("hides the model-step progress segment in managed mode", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      managedExperience: true,
    });
    mockDialog.onboardingOptions = { initialStep: 1, companyId: "c1" };
    mockCompany.companies = [{ id: "c1", name: "Auto Co", issuePrefix: "PAP" }];

    const { root } = await mount();

    // Managed mode walks 1 → 2 → 3 → 5 (the connect-a-model step hides its
    // picker), so the progress bar shows 4 segments, not 5.
    const segments = document.body.querySelectorAll('[aria-label^="Step "]');
    expect(segments.length).toBe(4);

    await act(async () => {
      root.unmount();
    });
  });

  it("shows all five progress segments in the unmanaged product", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({});
    mockDialog.onboardingOptions = { initialStep: 1, companyId: "c1" };
    mockCompany.companies = [{ id: "c1", name: "Auto Co", issuePrefix: "PAP" }];

    const { root } = await mount();

    const segments = document.body.querySelectorAll('[aria-label^="Step "]');
    expect(segments.length).toBe(5);

    await act(async () => {
      root.unmount();
    });
  });
});
