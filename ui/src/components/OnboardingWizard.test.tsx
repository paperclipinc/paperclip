// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterEnvironmentTestResult, CompanySecret } from "@paperclipai/shared";

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
const mockAccessApi = vi.hoisted(() => ({
  getCurrentBoardAccess: vi.fn(),
}));
const mockHealthApi = vi.hoisted(() => ({
  get: vi.fn(),
}));
const mockCloudCompaniesApi = vi.hoisted(() => ({
  create: vi.fn(),
}));
// Server-side truth for "is a credential connected" (deriveCredentialConnected
// reads this via the wizard's company-secrets query). Defaults to no secrets;
// individual tests override with mockResolvedValueOnce / mockResolvedValue.
const mockSecretsApi = vi.hoisted(() => ({
  list: vi.fn(async (): Promise<CompanySecret[]> => []),
  disable: vi.fn(async (id: string): Promise<CompanySecret> => ({ id }) as CompanySecret),
}));

// The real adapter registry eagerly imports every adapter package. The
// model/harness picker internals are out of scope here, so stub the adapter
// layer entirely and drive the grid through this knob. Every test in this
// file uses claude_local, so getUIAdapter always reports its credential
// setup descriptor (a single ANTHROPIC_API_KEY option) — that's the minimum
// needed to exercise the step-4 connect card wiring.
const mockAdapterRegistry = vi.hoisted(() => ({
  list: [] as Array<{ type: string }>,
  disabled: new Set<string>(),
  // Per-adapterType overrides for getUIAdapter(), keyed by adapterType. Tests
  // that need a second adapter (e.g. to exercise credential-binding scoping
  // across an adapter switch) populate this; anything not present falls back
  // to the claude_local-shaped default below.
  byType: {} as Record<
    string,
    {
      buildAdapterConfig: () => Record<string, unknown>;
      credentialSetup?: {
        options: Array<{ envKey: string; label: string; placeholder?: string }>;
      };
    }
  >,
}));

const mockAgentsApi = vi.hoisted(() => ({
  adapterModels: vi.fn(async () => [] as Array<{ id: string; label: string }>),
  testEnvironment: vi.fn(
    async (
      _companyId: string,
      _adapterType: string,
      _data: { adapterConfig: Record<string, unknown>; environmentId?: string | null },
    ): Promise<AdapterEnvironmentTestResult> => ({
      adapterType: "claude_local",
      status: "pass",
      checks: [],
      testedAt: new Date().toISOString(),
    }),
  ),
  hire: vi.fn(async (_companyId: string, _data: Record<string, unknown>) => ({
    agent: { id: "agent-1" },
    approval: null,
  })),
  instructionsBundle: vi.fn(async () => ({ entryFile: "AGENTS.md" })),
  saveInstructionsFile: vi.fn(async () => ({})),
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
vi.mock("../api/cloudCompanies", () => ({ cloudCompaniesApi: mockCloudCompaniesApi }));
vi.mock("../api/health", () => ({ healthApi: mockHealthApi }));
vi.mock("../api/goals", () => ({ goalsApi: mockGoalsApi }));
vi.mock("../api/access", () => ({
  accessApi: mockAccessApi,
}));
vi.mock("../api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("../api/secrets", () => ({ secretsApi: mockSecretsApi }));
vi.mock("../adapters", () => ({
  listUIAdapters: () => mockAdapterRegistry.list,
  getUIAdapter: (type: string) =>
    mockAdapterRegistry.byType[type] ?? {
      buildAdapterConfig: () => ({}),
      credentialSetup: {
        options: [
          {
            envKey: "ANTHROPIC_API_KEY",
            label: "Anthropic API key",
            placeholder: "sk-ant-...",
          },
        ],
      },
    },
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
  useDisabledAdaptersSync: () => mockAdapterRegistry.disabled,
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
// The credential-connect card itself is covered by its own test file
// (AdapterCredentialConnect.test.tsx); here we only need to exercise the
// wizard's wiring (rendering condition + onBind plumbing), so stub it down
// to a single button that invokes onBind with fixed test values.
vi.mock("./AdapterCredentialConnect", () => ({
  AdapterCredentialConnect: (props: {
    boundEnvKeys: string[];
    onBind: (envKey: string, secretId: string) => void;
    externalError?: string | null;
  }) => (
    <>
      <button
        type="button"
        data-testid="mock-credential-bind"
        onClick={() => props.onBind("ANTHROPIC_API_KEY", "sec-1")}
      >
        bound:{props.boundEnvKeys.join(",")}
      </button>
      {props.externalError && (
        <p data-testid="mock-credential-error">{props.externalError}</p>
      )}
    </>
  ),
}));
// Animation / canvas-ish children that add nothing to the logic under test.
vi.mock("./AsciiArtAnimation", () => ({ AsciiArtAnimation: () => null }));
vi.mock("./FrontDoor", () => ({ FrontDoor: () => null }));
vi.mock("./AgentCapsule", () => ({ AgentCapsule: () => null }));

import { ApiError } from "@/api/client";
import { OnboardingWizard } from "./OnboardingWizard";

function makeCompanySecret(overrides: Partial<CompanySecret> = {}): CompanySecret {
  return {
    id: "secret-1",
    companyId: "c1",
    scope: "company",
    ownerUserId: null,
    userSecretDefinitionId: null,
    key: "claude-local-anthropic-api-key",
    name: "ANTHROPIC_API_KEY",
    provider: "local_encrypted",
    status: "active",
    managedMode: "paperclip_managed",
    externalRef: null,
    providerConfigId: null,
    providerMetadata: null,
    latestVersion: 1,
    description: null,
    lastResolvedAt: null,
    lastRotatedAt: null,
    deletedAt: null,
    createdByAgentId: null,
    createdByUserId: "user-1",
    referenceCount: 1,
    createdAt: new Date("2026-05-06T00:00:00.000Z"),
    updatedAt: new Date("2026-05-06T00:00:00.000Z"),
    ...overrides,
  };
}

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

function findButtonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const buttons = Array.from(container.querySelectorAll("button"));
  const match = buttons.find((btn) => btn.textContent?.includes(text));
  if (!match) {
    throw new Error(`No button found with text "${text}"`);
  }
  return match as HTMLButtonElement;
}

describe("OnboardingWizard cloud first-run", () => {
  beforeEach(() => {
    window.localStorage.clear();
    mockDialog.onboardingOpen = true;
    mockDialog.onboardingOptions = {};
    mockDialog.onboardingRouteDismissed = false;
    mockCompany.companies = [];
    mockCompany.loading = false;
    mockAdapterRegistry.list = [];
    mockAdapterRegistry.disabled = new Set<string>();
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({});
    // Default to the self-hosted (local_trusted) product so the OSS paths are
    // exercised unless a test opts into cloud.
    mockHealthApi.get.mockResolvedValue({ deploymentMode: "local_trusted" });
    mockCloudCompaniesApi.create.mockResolvedValue({
      productSlug: "PCnew",
      url: "/PCnew/dashboard",
      name: "Fresh Co",
    });
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
    mockSecretsApi.list.mockReset().mockResolvedValue([]);
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

  it("lets an existing company confirm the mission without a manual rename (route entry drops on step 2)", async () => {
    // Reproduces the stuck-onboarding report: a cloud tenant whose company was
    // auto-created lands directly on the mission step (initialStep 2) via the
    // /<prefix>/onboarding route. The company name was never typed, so the old
    // guard `!companyName.trim()` left "Confirm mission" greyed out forever
    // (and localStorage persisted the dead state across reloads and logins).
    window.localStorage.setItem(
      ONBOARDING_STORAGE_KEY,
      JSON.stringify({
        step: 2,
        companyName: "",
        companyGoal: "Land my first few clients",
        missionPath: "direct",
        createdCompanyId: "c1",
      }),
    );
    mockDialog.onboardingOptions = { initialStep: 2, companyId: "c1" };
    mockCompany.companies = [
      { id: "c1", name: "Yesod Digital", issuePrefix: "PAP" },
    ];

    const { root } = await mount();

    const confirm = findButton("Confirm mission");
    expect(confirm).toBeTruthy();
    // The button must be clickable even though no name was typed: the company
    // already exists.
    expect(confirm!.disabled).toBe(false);

    await act(async () => {
      confirm!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    // The company already exists, so we never hit the blocked native create or
    // a blank rename — we just advance to naming the team lead.
    expect(mockCompaniesApi.create).not.toHaveBeenCalled();
    expect(mockCompaniesApi.update).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("offers a Back button on the mission step so typed answers are recoverable", async () => {
    // Second half of the same report: "no back buttons ... you have to start
    // all over." The footer Back was hidden whenever step === initialStep, so a
    // route entry on step 2 had no way back to adjust the company name.
    window.localStorage.setItem(
      ONBOARDING_STORAGE_KEY,
      JSON.stringify({
        step: 2,
        companyName: "",
        companyGoal: "Land my first few clients",
        missionPath: "direct",
        createdCompanyId: "c1",
      }),
    );
    mockDialog.onboardingOptions = { initialStep: 2, companyId: "c1" };
    mockCompany.companies = [
      { id: "c1", name: "Yesod Digital", issuePrefix: "PAP" },
    ];

    const { root } = await mount();

    const back = findButton("Back");
    expect(back).toBeTruthy();
    expect(back!.disabled).toBe(false);

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

  it("creates the FIRST company via the native create in cloud mode (server forces the stack)", async () => {
    mockHealthApi.get.mockResolvedValue({ deploymentMode: "authenticated" });
    window.localStorage.setItem(
      ONBOARDING_STORAGE_KEY,
      JSON.stringify({
        step: 2,
        companyName: "Fresh Co",
        companyGoal: "Ship it",
        missionPath: "direct",
      }),
    );
    // Cloud, but the user has NO company yet → the first-company path is the
    // native companiesApi.create (PR A makes the server create the stack
    // company), NOT the gateway's additional-company endpoint.
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
    expect(mockCloudCompaniesApi.create).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("routes an ADDITIONAL company through the cloud endpoint in cloud mode (never the blocked native create)", async () => {
    mockHealthApi.get.mockResolvedValue({ deploymentMode: "authenticated" });
    // jsdom does not implement navigation; capture the hard-redirect target.
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, assign },
    });
    window.localStorage.setItem(
      ONBOARDING_STORAGE_KEY,
      JSON.stringify({
        step: 2,
        companyName: "Fresh Co",
        companyGoal: "Ship it",
        missionPath: "direct",
      }),
    );
    // The user already has a stack company and starts a brand-new one (no
    // createdCompanyId) → creating an ADDITIONAL company goes through the
    // gateway endpoint and hard-navigates to the new tenant.
    mockDialog.onboardingOptions = {};
    mockCompany.companies = [{ id: "existing", name: "First Co", issuePrefix: "FST" }];

    const { root } = await mount();

    const confirm = findButton("Confirm mission");
    expect(confirm).toBeTruthy();
    await act(async () => {
      confirm!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    // The gateway-owned cloud endpoint is used, NOT the blocked native create.
    expect(mockCloudCompaniesApi.create).toHaveBeenCalledWith({ name: "Fresh Co" });
    expect(mockCompaniesApi.create).not.toHaveBeenCalled();
    expect(assign).toHaveBeenCalledWith("/PCnew/dashboard");

    await act(async () => {
      root.unmount();
    });
  });

  it("offers a Subscribe link on the additional-company plan gate instead of a dead end", async () => {
    mockHealthApi.get.mockResolvedValue({ deploymentMode: "authenticated" });
    mockCloudCompaniesApi.create.mockRejectedValueOnce(
      new ApiError("upgrade_required", 402, { error: "upgrade_required" }),
    );
    window.localStorage.setItem(
      ONBOARDING_STORAGE_KEY,
      JSON.stringify({
        step: 2,
        companyName: "Fresh Co",
        companyGoal: "Ship it",
        missionPath: "direct",
      }),
    );
    mockDialog.onboardingOptions = {};
    mockCompany.companies = [{ id: "existing", name: "First Co", issuePrefix: "FST" }];

    const { root } = await mount();

    const confirm = findButton("Confirm mission");
    expect(confirm).toBeTruthy();
    await act(async () => {
      confirm!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(document.body.textContent).toContain("Your trial includes one company");
    const link = Array.from(document.body.querySelectorAll("a")).find(
      (a) => a.textContent?.includes("Subscribe"),
    );
    expect(link).toBeTruthy();
    expect(link?.getAttribute("href")).toBe("/account");
    // The link sits inside a text-destructive error paragraph but is a normal
    // navigation action, not a danger action - it needs an explicit
    // non-destructive color so it doesn't inherit the error paragraph's red.
    expect(link?.className).not.toContain("text-destructive");
    expect(link?.className).toContain("text-foreground");
    // Back stays available too - the wizard must never trap the user here.
    expect(findButton("Back")).toBeTruthy();

    await act(async () => {
      root.unmount();
    });
  });

  it("does not show the Subscribe link for a billing_update_failed 402 (not the upsell case)", async () => {
    mockHealthApi.get.mockResolvedValue({ deploymentMode: "authenticated" });
    mockCloudCompaniesApi.create.mockRejectedValueOnce(
      new ApiError("billing_update_failed", 402, { error: "billing_update_failed" }),
    );
    window.localStorage.setItem(
      ONBOARDING_STORAGE_KEY,
      JSON.stringify({
        step: 2,
        companyName: "Fresh Co",
        companyGoal: "Ship it",
        missionPath: "direct",
      }),
    );
    mockDialog.onboardingOptions = {};
    mockCompany.companies = [{ id: "existing", name: "First Co", issuePrefix: "FST" }];

    const { root } = await mount();

    const confirm = findButton("Confirm mission");
    await act(async () => {
      confirm!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(document.body.textContent).toContain("We could not update your billing");
    const link = Array.from(document.body.querySelectorAll("a")).find(
      (a) => a.textContent?.includes("Subscribe"),
    );
    expect(link).toBeFalsy();

    await act(async () => {
      root.unmount();
    });
  });

  it("shows all five progress segments", async () => {
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({});
    mockDialog.onboardingOptions = { initialStep: 1, companyId: "c1" };
    mockCompany.companies = [{ id: "c1", name: "Auto Co", issuePrefix: "PAP" }];

    const { root } = await mount();

    const segments = document.body.querySelectorAll('[aria-label^="Step "]');
    expect(segments.length).toBe(5);

    await act(async () => {
      root.unmount();
    });
  });

  it("snaps a disabled default adapterType to the first enabled adapter", async () => {
    // A cloud sandbox registry without claude_local: the server disables it,
    // so the wizard's claude_local default must not survive as an invisible
    // selection (it would create an agent that can never acquire a lease).
    mockAdapterRegistry.list = [
      { type: "claude_local" },
      { type: "codex_local" },
      { type: "opencode_local" },
    ];
    mockAdapterRegistry.disabled = new Set(["claude_local"]);

    const { root } = await mount();

    const saved = JSON.parse(
      window.localStorage.getItem(ONBOARDING_STORAGE_KEY) ?? "{}",
    );
    expect(saved.adapterType).toBe("codex_local");

    await act(async () => {
      root.unmount();
    });
  });

  it("re-syncs a restored draft once companies resolve asynchronously (companies start empty/loading)", async () => {
    // Regression for the initializer-only restore bug: the inner wizard's
    // ~20 useState(saved?.x ?? default) initializers only read `saved` on
    // their very first render. useCompany() starts with companies=[] and
    // loading=true and resolves later; if the inner component mounted before
    // that resolution, restoreOnboardingState would see an empty companies
    // list and the whole draft would lock to defaults forever, even after
    // companies arrive. The fix defers mounting the inner wizard until
    // companies settle.
    window.localStorage.setItem(
      ONBOARDING_STORAGE_KEY,
      JSON.stringify({
        step: 3,
        companyName: "Saved Co",
        agentName: "Ops Lead",
        createdCompanyId: "c1",
      }),
    );
    mockDialog.onboardingOptions = {};
    mockCompany.companies = [];
    mockCompany.loading = true;

    const { container, root, queryClient } = render();
    const renderTree = () =>
      act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <OnboardingWizard />
          </QueryClientProvider>,
        );
      });

    await renderTree();
    await flushReact();

    // Nothing mounts yet — no premature guess, and the draft is not touched.
    expect(container.textContent).toBe("");
    expect(document.body.textContent).toBe("");
    expect(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)).not.toBeNull();

    // Companies resolve asynchronously, owning the saved company.
    mockCompany.companies = [{ id: "c1", name: "Saved Co", issuePrefix: "SC" }];
    mockCompany.loading = false;

    await renderTree();
    await flushReact();

    // The draft is restored once companies settle: step 3 (Create your team
    // lead) with the saved agent name in the input, not the defaults
    // (step 0, "Chief of staff").
    expect(document.body.textContent).toContain("Create your team lead");
    const nameInput = document.body.querySelector(
      'input[placeholder="Chief of staff"]',
    ) as HTMLInputElement | null;
    expect(nameInput?.value).toBe("Ops Lead");
    const currentStep = document.body.querySelector('[aria-current="step"]');
    expect(currentStep?.getAttribute("aria-label")).toBe("Step 3");

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps an enabled saved adapterType untouched", async () => {
    mockAdapterRegistry.list = [
      { type: "claude_local" },
      { type: "codex_local" },
    ];
    window.localStorage.setItem(
      ONBOARDING_STORAGE_KEY,
      JSON.stringify({ step: 0, adapterType: "claude_local" }),
    );

    const { root } = await mount();

    const saved = JSON.parse(
      window.localStorage.getItem(ONBOARDING_STORAGE_KEY) ?? "{}",
    );
    expect(saved.adapterType).toBe("claude_local");

    await act(async () => {
      root.unmount();
    });
  });
});

describe("OnboardingWizard step 4 — guided credential connect", () => {
  beforeEach(() => {
    window.localStorage.clear();
    mockDialog.onboardingOpen = true;
    mockDialog.onboardingOptions = { initialStep: 4, companyId: "c1" };
    mockCompany.companies = [{ id: "c1", name: "Test Co", issuePrefix: "TC" }];
    mockAdapterRegistry.list = [{ type: "claude_local" }];
    mockAdapterRegistry.disabled = new Set<string>();
    mockAdapterRegistry.byType = {};
    mockAgentsApi.adapterModels.mockClear();
    mockAgentsApi.testEnvironment.mockClear();
    mockAgentsApi.hire.mockClear();
    mockAgentsApi.instructionsBundle.mockClear();
    mockAgentsApi.saveInstructionsFile.mockClear();
    mockSecretsApi.list.mockReset().mockResolvedValue([]);
    mockSecretsApi.disable.mockReset().mockResolvedValue({ id: "sec-1" } as CompanySecret);
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders the connect card on step 4 with a created company and empty bindings", async () => {
    const { root } = await mount();

    expect(
      document.body.querySelector('[data-testid="mock-credential-bind"]'),
    ).not.toBeNull();
    // No bindings yet.
    expect(
      document.body.querySelector('[data-testid="mock-credential-bind"]')
        ?.textContent,
    ).toBe("bound:");

    await act(async () => {
      root.unmount();
    });
  });

  it("merges an in-session binding into the hire payload without ever writing it to the persisted draft", async () => {
    const { root } = await mount();

    const bindButton = findButtonByText(document.body, "bound:");
    await act(async () => {
      bindButton.click();
    });
    await flushReact();

    // Bindings are session-only: localStorage is per-origin, not per-account,
    // so a restored binding could name a secret belonging to another
    // company, which the server rejects with "Secret must belong to same
    // company". The persisted draft must never carry the key at all.
    const saved = JSON.parse(
      window.localStorage.getItem(ONBOARDING_STORAGE_KEY) ?? "{}",
    );
    expect(saved).not.toHaveProperty("credentialBindings");

    const heartbeatButton = findButtonByText(document.body, "Give it a heartbeat");
    await act(async () => {
      heartbeatButton.click();
    });
    await flushReact();

    expect(mockAgentsApi.hire).toHaveBeenCalledTimes(1);
    const hirePayload = mockAgentsApi.hire.mock.calls[0]?.[1] as {
      adapterConfig: { env?: Record<string, unknown> };
    };
    expect(hirePayload.adapterConfig.env?.ANTHROPIC_API_KEY).toEqual({
      type: "secret_ref",
      secretId: "sec-1",
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("omits the env key from the hire payload when the adapter needs no credential and nothing is bound", async () => {
    // An adapter with no credentialSetup requires no credential, so the
    // activation gate is satisfied and a keyless hire is legitimate. This keeps
    // the "no bindings -> no env key" merge behavior exercised now that the
    // credential-requiring default adapter blocks keyless activation.
    mockAdapterRegistry.byType.claude_local = {
      buildAdapterConfig: () => ({}),
    };

    const { root } = await mount();

    const heartbeatButton = findButtonByText(document.body, "Give it a heartbeat");
    expect(heartbeatButton.disabled).toBe(false);
    await act(async () => {
      heartbeatButton.click();
    });
    await flushReact();

    expect(mockAgentsApi.hire).toHaveBeenCalledTimes(1);
    const hirePayload = mockAgentsApi.hire.mock.calls[0]?.[1] as {
      adapterConfig: Record<string, unknown>;
    };
    expect(hirePayload.adapterConfig).not.toHaveProperty("env");

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps the heartbeat CTA disabled until a required credential is bound", async () => {
    // Default adapter (claude_local) advertises an ANTHROPIC_API_KEY option, so
    // activation must stay gated until the user connects a credential.
    const { root } = await mount();

    const heartbeatButton = findButtonByText(document.body, "Give it a heartbeat");
    expect(heartbeatButton.disabled).toBe(true);

    const bindButton = findButtonByText(document.body, "bound:");
    await act(async () => {
      bindButton.click();
    });
    await flushReact();

    const enabledButton = findButtonByText(document.body, "Give it a heartbeat");
    expect(enabledButton.disabled).toBe(false);

    await act(async () => {
      root.unmount();
    });
  });

  it("clears the binding, keeps the heartbeat CTA disabled, and shows a plain-language error when the post-bind probe rejects the credential", async () => {
    // This is the bug this branch exists to fix: pasting an invalid key
    // must not sail through as "Connected" with the gate open.
    mockAgentsApi.testEnvironment.mockResolvedValueOnce({
      adapterType: "claude_local",
      status: "fail",
      checks: [
        {
          code: "claude_hello_probe_credential_rejected",
          level: "error",
          message: "Claude rejected the provided credential.",
          detail: 'API Error: 401 {"type":"error","error":{"type":"authentication_error"}}',
          authFailure: true,
        },
      ],
      testedAt: new Date().toISOString(),
    });

    const { root } = await mount();

    const bindButton = findButtonByText(document.body, "bound:");
    await act(async () => {
      bindButton.click();
    });
    await flushReact();

    // The in-session binding was undone: the mocked card's boundEnvKeys is
    // empty again, and deriveCredentialConnected reads it as not connected.
    expect(
      document.body.querySelector('[data-testid="mock-credential-bind"]')
        ?.textContent,
    ).toBe("bound:");

    // A plain-language error is surfaced on the card — never the raw
    // provider/CLI detail text.
    const errorEl = document.body.querySelector(
      '[data-testid="mock-credential-error"]',
    );
    expect(errorEl?.textContent).toBe(
      "That key was rejected by the provider. Check it and paste it again.",
    );
    // The credential card's own error must never repeat the raw provider
    // detail (the separate, pre-existing "Adapter environment check" /
    // Manual debug panel below intentionally does show that raw text for
    // debugging — that panel is out of scope for this fix).
    expect(errorEl?.textContent).not.toContain("authentication_error");

    // The heartbeat gate must not open on the strength of the rejected binding.
    const heartbeatButton = findButtonByText(document.body, "Give it a heartbeat");
    expect(heartbeatButton.disabled).toBe(true);

    // The rejected secret is disabled server-side too, so a page reload
    // can't fall through deriveCredentialConnected's company-secrets
    // fallback and silently re-open the gate on the orphaned active secret.
    expect(mockSecretsApi.disable).toHaveBeenCalledWith("sec-1");

    await act(async () => {
      root.unmount();
    });
  });

  it("does not re-open the gate on a fresh mount for a DIFFERENT adapter that happens to share the envKey name", async () => {
    // ANTHROPIC_API_KEY is advertised by claude_local, opencode_local, and
    // pi_local independently. A rejection recorded for claude_local must not
    // leak into another adapter's own credential state.
    mockAdapterRegistry.byType.opencode_local = {
      buildAdapterConfig: () => ({}),
      credentialSetup: {
        options: [
          {
            envKey: "ANTHROPIC_API_KEY",
            label: "Anthropic API key",
            placeholder: "sk-ant-...",
          },
        ],
      },
    };
    mockAdapterRegistry.list = [
      { type: "claude_local" },
      { type: "opencode_local" },
    ];
    mockAgentsApi.testEnvironment.mockResolvedValueOnce({
      adapterType: "claude_local",
      status: "fail",
      checks: [
        {
          code: "claude_hello_probe_credential_rejected",
          level: "error",
          message: "Claude rejected the provided credential.",
          authFailure: true,
        },
      ],
      testedAt: new Date().toISOString(),
    });

    const { root } = await mount();

    const bindButton = findButtonByText(document.body, "bound:");
    await act(async () => {
      bindButton.click();
    });
    await flushReact();

    // claude_local's own gate is closed by the rejection.
    expect(findButtonByText(document.body, "Give it a heartbeat").disabled).toBe(
      true,
    );

    // Switching to opencode_local (same ANTHROPIC_API_KEY envKey, but a
    // DIFFERENT adapter and thus a different failure record) and binding it
    // fresh must not read as pre-failed.
    mockAgentsApi.testEnvironment.mockResolvedValueOnce({
      adapterType: "opencode_local",
      status: "pass",
      checks: [],
      testedAt: new Date().toISOString(),
    });
    // The test-mocked getAdapterDisplay marks nothing as "recommended", so
    // every adapter (including opencode_local) lands in the collapsed
    // "More Agent Adapter Types" section.
    const moreToggle = findButtonByText(document.body, "More Agent Adapter Types");
    await act(async () => {
      moreToggle.click();
    });
    await flushReact();

    const adapterButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent === "opencode_local",
    );
    expect(adapterButton).not.toBeUndefined();
    await act(async () => {
      adapterButton?.click();
    });
    await flushReact();

    const bindButtonAgain = findButtonByText(document.body, "bound:");
    await act(async () => {
      bindButtonAgain.click();
    });
    await flushReact();

    expect(findButtonByText(document.body, "Give it a heartbeat").disabled).toBe(
      false,
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("refuses to hire when a fresh mount's orphaned active company secret still fails the live probe (no dead-end: error shown, gate closes, Back still works)", async () => {
    // Simulates the reload gap this fix closes: an active company secret
    // survives from an earlier attempt (e.g. its disable call itself
    // failed), so on a fresh mount there is no in-session failure record
    // and the gate reads as open purely via deriveCredentialConnected's
    // company-secrets fallback. handleGiveHeartbeat's own fresh-probe check
    // must still refuse to hire rather than trusting that "open" gate.
    mockSecretsApi.list.mockResolvedValue([
      makeCompanySecret({ status: "active" }),
    ]);
    mockAgentsApi.testEnvironment.mockResolvedValueOnce({
      adapterType: "claude_local",
      status: "fail",
      checks: [
        {
          code: "claude_hello_probe_credential_rejected",
          level: "error",
          message: "Claude rejected the provided credential.",
          authFailure: true,
        },
      ],
      testedAt: new Date().toISOString(),
    });

    const { root } = await mount();
    await flushReact();

    // The gate reads as open on mount purely from the orphaned secret —
    // nothing was bound this session.
    const heartbeatButton = findButtonByText(document.body, "Give it a heartbeat");
    expect(heartbeatButton.disabled).toBe(false);

    await act(async () => {
      heartbeatButton.click();
    });
    await flushReact();

    // The probe was NOT run against an empty/credential-less config: it
    // actually submitted the orphaned secret's own secret_ref, materialized
    // from deriveCredentialConnected's own name-matching logic
    // (findMatchingCompanySecret) rather than the gate being trusted blind.
    // Without this, the probe could only ever see the soft "please log in"
    // case (no credential present to reject) and this whole test would be
    // asserting against a scenario that can't occur in the real app.
    const probeCall = mockAgentsApi.testEnvironment.mock.calls[0] as
      | [string, string, { adapterConfig: { env?: Record<string, unknown> } }]
      | undefined;
    expect(probeCall?.[2]?.adapterConfig.env?.ANTHROPIC_API_KEY).toEqual({
      type: "secret_ref",
      secretId: "secret-1",
    });

    // No agent was created against the known-bad credential.
    expect(mockAgentsApi.hire).not.toHaveBeenCalled();

    // The rejected, materialized secret is disabled server-side too.
    expect(mockSecretsApi.disable).toHaveBeenCalledWith("secret-1");

    // The rejection error is visible and the user is kept on the step —
    // not a dead end. Back must still be reachable and enabled.
    expect(document.body.textContent).toContain(
      "That key was rejected by the provider. Check it and paste it again.",
    );
    expect(findButtonByText(document.body, "Back").disabled).toBe(false);

    // The gate closes for the rest of this session so retrying without a
    // fresh bind can't loop the same way.
    expect(
      findButtonByText(document.body, "Give it a heartbeat").disabled,
    ).toBe(true);

    await act(async () => {
      root.unmount();
    });
  });

  it("materializes a VALID post-reload company secret into both the probe and the hire payload", async () => {
    // The counterpart to the orphaned-secret regression above: a user who
    // successfully bound a valid key, then reloaded BEFORE clicking "Give
    // it a heartbeat" (or simply opened onboarding fresh with a company
    // that already has a valid secret from a prior session). No session
    // binding exists, so without materializing the match,
    // mergeCredentialBindings would ship neither the probe nor the hire any
    // credential at all — a credential-less agent that fails its first run
    // even though the key itself was always fine.
    mockSecretsApi.list.mockResolvedValue([
      makeCompanySecret({ id: "secret-valid", status: "active" }),
    ]);
    mockAgentsApi.testEnvironment.mockResolvedValueOnce({
      adapterType: "claude_local",
      status: "pass",
      checks: [],
      testedAt: new Date().toISOString(),
    });

    const { root } = await mount();
    await flushReact();

    // The gate reads as open purely from the company secret.
    const heartbeatButton = findButtonByText(document.body, "Give it a heartbeat");
    expect(heartbeatButton.disabled).toBe(false);

    await act(async () => {
      heartbeatButton.click();
    });
    await flushReact();

    // The live probe actually tested the matched secret, not an empty config.
    const probeCall = mockAgentsApi.testEnvironment.mock.calls[0] as
      | [string, string, { adapterConfig: { env?: Record<string, unknown> } }]
      | undefined;
    expect(probeCall?.[2]?.adapterConfig.env?.ANTHROPIC_API_KEY).toEqual({
      type: "secret_ref",
      secretId: "secret-valid",
    });

    // The hire succeeded, and its payload carries the same binding — the
    // created agent is not credential-less.
    expect(mockAgentsApi.hire).toHaveBeenCalledTimes(1);
    const hirePayload = mockAgentsApi.hire.mock.calls[0]?.[1] as {
      adapterConfig: { env?: Record<string, unknown> };
    };
    expect(hirePayload.adapterConfig.env?.ANTHROPIC_API_KEY).toEqual({
      type: "secret_ref",
      secretId: "secret-valid",
    });

    // A valid credential never gets disabled.
    expect(mockSecretsApi.disable).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps the existing permissive behavior (Connected stands, gate opens) when the probe fails for a non-auth reason", async () => {
    mockAgentsApi.testEnvironment.mockResolvedValueOnce({
      adapterType: "claude_local",
      status: "fail",
      checks: [
        {
          code: "claude_command_unresolvable",
          level: "error",
          message: "Command is not executable: claude",
        },
      ],
      testedAt: new Date().toISOString(),
    });

    const { root } = await mount();

    const bindButton = findButtonByText(document.body, "bound:");
    await act(async () => {
      bindButton.click();
    });
    await flushReact();

    expect(
      document.body.querySelector('[data-testid="mock-credential-bind"]')
        ?.textContent,
    ).toBe("bound:ANTHROPIC_API_KEY");
    expect(
      document.body.querySelector('[data-testid="mock-credential-error"]'),
    ).toBeNull();

    const heartbeatButton = findButtonByText(document.body, "Give it a heartbeat");
    expect(heartbeatButton.disabled).toBe(false);

    await act(async () => {
      root.unmount();
    });
  });

  it("maps a thrown adapter-environment-test error to plain language and stays permissive", async () => {
    mockAgentsApi.testEnvironment.mockRejectedValueOnce(
      new Error("Secret must belong to same company"),
    );

    const { root } = await mount();

    const bindButton = findButtonByText(document.body, "bound:");
    await act(async () => {
      bindButton.click();
    });
    await flushReact();

    // Permissive: the check "cannot run", so the binding stands.
    expect(
      document.body.querySelector('[data-testid="mock-credential-bind"]')
        ?.textContent,
    ).toBe("bound:ANTHROPIC_API_KEY");
    const heartbeatButton = findButtonByText(document.body, "Give it a heartbeat");
    expect(heartbeatButton.disabled).toBe(false);

    // The raw internal server message never renders; a plain sentence does.
    expect(document.body.textContent).not.toContain(
      "Secret must belong to same company",
    );
    expect(document.body.textContent).toContain(
      "We could not run the adapter check right now. You can continue and retry the test later.",
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("lists warn-level checks even when the overall status is pass", async () => {
    mockAgentsApi.testEnvironment.mockResolvedValueOnce({
      adapterType: "claude_local",
      status: "pass",
      checks: [
        {
          code: "claude_subscription_auth_code",
          level: "warn",
          message: "Using a short-lived auth code; re-run claude login soon.",
        },
      ],
      testedAt: new Date().toISOString(),
    });

    const { root } = await mount();

    const testButton = findButtonByText(document.body, "Test now");
    await act(async () => {
      testButton.click();
    });
    await flushReact();

    const bodyText = document.body.textContent ?? "";
    // Exactly one green "Passed" pill — the warn rows below must not repeat
    // the pass banner.
    expect(bodyText.match(/Passed/g)).toHaveLength(1);
    expect(bodyText).toContain(
      "Using a short-lived auth code; re-run claude login soon.",
    );
    // The warn rows render in the house amber warn styling, outside the
    // green pass pill.
    const warnMessageEl = Array.from(
      document.body.querySelectorAll("div, p, span"),
    )
      .filter((el) =>
        el.textContent?.includes(
          "Using a short-lived auth code; re-run claude login soon.",
        ),
      )
      .pop();
    expect(warnMessageEl).toBeDefined();
    expect(warnMessageEl?.closest('[class*="amber"]')).not.toBeNull();
    expect(warnMessageEl?.closest('[class*="green"]')).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it("never restores credentialBindings from a saved draft, even for the owned, currently-selected company", async () => {
    // A binding named in a saved draft names a secret id. Restoring it would
    // let a browser carrying a stale draft (e.g. after switching accounts,
    // still on the same company) hand a secret id to the server that may no
    // longer resolve, or may belong to a different company entirely — the
    // "Secret must belong to same company" failure this fix exists for.
    // Bindings are session-only now, so the saved value below must be
    // ignored no matter what.
    window.localStorage.setItem(
      ONBOARDING_STORAGE_KEY,
      JSON.stringify({
        step: 4,
        agentName: "Chief of staff",
        adapterType: "claude_local",
        credentialBindings: {
          ANTHROPIC_API_KEY: { type: "secret_ref", secretId: "sec-draft" },
        },
      }),
    );
    // No matching secret on the company either, so the gate has no other way
    // to read as satisfied.
    mockSecretsApi.list.mockResolvedValue([]);

    const { root } = await mount();

    // The connect card starts unbound: the draft's binding was discarded.
    expect(
      document.body.querySelector('[data-testid="mock-credential-bind"]')
        ?.textContent,
    ).toBe("bound:");

    // With nothing bound and no matching company secret, the gate stays
    // closed and hiring is blocked rather than silently sending the stale
    // secret id.
    const heartbeatButton = findButtonByText(document.body, "Give it a heartbeat");
    expect(heartbeatButton.disabled).toBe(true);

    await act(async () => {
      root.unmount();
    });
  });

  it("resets in-session credential bindings when createdCompanyId changes mid-session (company switch, no reload)", async () => {
    // credentialBindings is company-scoped even though it is never persisted
    // (see the [createdCompanyId] effect in OnboardingWizardInner). Exercise
    // the mid-session path: the dialog reopens with a DIFFERENT companyId
    // while the wizard stays mounted, no page reload, so a binding collected
    // under the previous company must not silently read as "connected" for
    // the new one.
    const { root, queryClient } = render();
    const renderTree = () =>
      act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <OnboardingWizard />
          </QueryClientProvider>,
        );
      });

    await renderTree();
    await flushReact();

    const bindButton = findButtonByText(document.body, "bound:");
    await act(async () => {
      bindButton.click();
    });
    await flushReact();

    expect(
      document.body.querySelector('[data-testid="mock-credential-bind"]')
        ?.textContent,
    ).toBe("bound:ANTHROPIC_API_KEY");

    // Switch companies mid-session: same adapterType (claude_local), so the
    // AdapterCredentialConnect instance (keyed on adapterType) is NOT
    // remounted — only the [createdCompanyId] effect can be responsible for
    // clearing the binding.
    mockDialog.onboardingOptions = { initialStep: 4, companyId: "c2" };
    mockCompany.companies = [
      { id: "c1", name: "Test Co", issuePrefix: "TC" },
      { id: "c2", name: "Second Co", issuePrefix: "SC" },
    ];
    mockSecretsApi.list.mockResolvedValue([]);

    await renderTree();
    await flushReact();

    expect(
      document.body.querySelector('[data-testid="mock-credential-bind"]')
        ?.textContent,
    ).toBe("bound:");
    const heartbeatButton = findButtonByText(document.body, "Give it a heartbeat");
    expect(heartbeatButton.disabled).toBe(true);

    await act(async () => {
      root.unmount();
    });
  });

  it("filters a stale in-session binding from a previously-selected adapter out of the hire payload, and materializes the current adapter's OWN matching company secret into it instead", async () => {
    // gemini_local has its own credential option (GEMINI_API_KEY), disjoint
    // from claude_local's ANTHROPIC_API_KEY.
    mockAdapterRegistry.byType.gemini_local = {
      buildAdapterConfig: () => ({}),
      credentialSetup: {
        options: [
          {
            envKey: "GEMINI_API_KEY",
            label: "Gemini API key",
            placeholder: "AIza...",
          },
        ],
      },
    };
    // gemini_local must be visible in the registry, or the wizard's
    // snap-to-enabled effect (fork-only: 800195fea) would silently reset the
    // saved gemini_local selection back to the first enabled adapter before
    // this test ever exercises the binding filter.
    mockAdapterRegistry.list = [
      { type: "claude_local" },
      { type: "gemini_local" },
    ];
    // adapterType itself still restores fine (only credentialBindings is
    // stripped by restoreOnboardingState).
    window.localStorage.setItem(
      ONBOARDING_STORAGE_KEY,
      JSON.stringify({
        step: 4,
        agentName: "Chief of staff",
        adapterType: "gemini_local",
      }),
    );
    // The company already has an active secret matching gemini_local's own
    // naming convention (see credentialSecretName), so the server-side truth
    // satisfies the gate without any session binding.
    mockSecretsApi.list.mockResolvedValue([
      makeCompanySecret({
        id: "sec-gemini",
        key: "gemini-local-gemini-api-key",
        name: "GEMINI_API_KEY",
      }),
    ]);

    const { root } = await mount();

    // Simulate a stale in-session binding left over from a moment when
    // claude_local was selected (the mocked connect card always binds
    // ANTHROPIC_API_KEY regardless of the adapter currently on screen).
    const bindButton = findButtonByText(document.body, "bound:");
    await act(async () => {
      bindButton.click();
    });
    await flushReact();

    const heartbeatButton = findButtonByText(document.body, "Give it a heartbeat");
    // The gate is satisfied by the real company secret for GEMINI_API_KEY,
    // not by the stale ANTHROPIC_API_KEY session binding.
    expect(heartbeatButton.disabled).toBe(false);
    await act(async () => {
      heartbeatButton.click();
    });
    await flushReact();

    expect(mockAgentsApi.hire).toHaveBeenCalledTimes(1);
    const hirePayload = mockAgentsApi.hire.mock.calls[0]?.[1] as {
      adapterConfig: { env?: Record<string, unknown> };
    };
    // The stale ANTHROPIC_API_KEY binding collected under the
    // previously-selected adapter is filtered out by mergeCredentialBindings
    // (it only keeps envKeys the current adapter's credentialSetup
    // advertises). gemini_local's own credential was never session-bound
    // this session, but handleGiveHeartbeat materializes the matching
    // company secret the gate itself was satisfied by, so the hire payload
    // still carries a real credential rather than shipping a credential-less
    // agent (the reload gap this covers: without materializing, this agent
    // would be hired with no env override at all and fail its first run).
    expect(hirePayload.adapterConfig.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(hirePayload.adapterConfig.env?.GEMINI_API_KEY).toEqual({
      type: "secret_ref",
      secretId: "sec-gemini",
    });

    await act(async () => {
      root.unmount();
    });
  });
});

describe("mergeCredentialBindings", () => {
  // Exercised indirectly above through the wizard's call sites; this
  // isolates the merge/filter semantics themselves since the helper isn't
  // exported (it's an internal implementation detail of the wizard), driven
  // through an in-session bind + hire, so the base-env-survives case doesn't
  // need a real buildAdapterConfig() with forceUnset wiring.
  beforeEach(() => {
    window.localStorage.clear();
    mockDialog.onboardingOpen = true;
    mockDialog.onboardingOptions = { initialStep: 4, companyId: "c1" };
    mockCompany.companies = [{ id: "c1", name: "Test Co", issuePrefix: "TC" }];
    mockAdapterRegistry.list = [{ type: "claude_local" }];
    mockAdapterRegistry.disabled = new Set<string>();
    mockAdapterRegistry.byType = {};
    mockAgentsApi.adapterModels.mockClear();
    mockAgentsApi.testEnvironment.mockClear();
    mockAgentsApi.hire.mockClear();
    mockAgentsApi.instructionsBundle.mockClear();
    mockAgentsApi.saveInstructionsFile.mockClear();
    mockSecretsApi.list.mockReset().mockResolvedValue([]);
    mockSecretsApi.disable.mockReset().mockResolvedValue({ id: "sec-1" } as CompanySecret);
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("merges an in-session binding on top of the base config's own env instead of replacing it", async () => {
    // Simulate buildAdapterConfig() already producing a base env entry (e.g.
    // the forceUnsetAnthropicApiKey plain-value marker) by having the
    // claude_local adapter's buildAdapterConfig stub return one for a key
    // other than the credential option under test, so the merge's
    // "survives alongside" behavior is unambiguous.
    mockAdapterRegistry.byType.claude_local = {
      buildAdapterConfig: () => ({
        env: { SOME_OTHER_VAR: { type: "plain", value: "kept" } },
      }),
      credentialSetup: {
        options: [
          {
            envKey: "ANTHROPIC_API_KEY",
            label: "Anthropic API key",
            placeholder: "sk-ant-...",
          },
        ],
      },
    };

    const { root } = await mount();

    // The mocked connect card always binds ANTHROPIC_API_KEY, which matches
    // this adapter's own credential option.
    const bindButton = findButtonByText(document.body, "bound:");
    await act(async () => {
      bindButton.click();
    });
    await flushReact();

    const heartbeatButton = findButtonByText(document.body, "Give it a heartbeat");
    await act(async () => {
      heartbeatButton.click();
    });
    await flushReact();

    expect(mockAgentsApi.hire).toHaveBeenCalledTimes(1);
    const hirePayload = mockAgentsApi.hire.mock.calls[0]?.[1] as {
      adapterConfig: { env?: Record<string, unknown> };
    };
    // The base config's own env entry survives the merge...
    expect(hirePayload.adapterConfig.env?.SOME_OTHER_VAR).toEqual({
      type: "plain",
      value: "kept",
    });
    // ...alongside the in-session binding for the current adapter's
    // credential option.
    expect(hirePayload.adapterConfig.env?.ANTHROPIC_API_KEY).toEqual({
      type: "secret_ref",
      secretId: "sec-1",
    });

    await act(async () => {
      root.unmount();
    });
  });
});
