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
const mockAccessApi = vi.hoisted(() => ({
  getCurrentBoardAccess: vi.fn(),
}));
const mockHealthApi = vi.hoisted(() => ({
  get: vi.fn(),
}));
const mockCloudCompaniesApi = vi.hoisted(() => ({
  create: vi.fn(),
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
  testEnvironment: vi.fn(async () => ({
    adapterType: "claude_local",
    status: "pass" as const,
    checks: [] as Array<{
      code: string;
      level: "info" | "warn" | "error";
      message: string;
      detail?: string | null;
      hint?: string | null;
    }>,
    testedAt: new Date().toISOString(),
  })),
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
  }) => (
    <button
      type="button"
      data-testid="mock-credential-bind"
      onClick={() => props.onBind("ANTHROPIC_API_KEY", "sec-1")}
    >
      bound:{props.boundEnvKeys.join(",")}
    </button>
  ),
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

  it("persists a binding to the draft and merges it into the hire payload", async () => {
    const { root } = await mount();

    const bindButton = findButtonByText(document.body, "bound:");
    await act(async () => {
      bindButton.click();
    });
    await flushReact();

    const saved = JSON.parse(
      window.localStorage.getItem(ONBOARDING_STORAGE_KEY) ?? "{}",
    );
    expect(saved.credentialBindings).toEqual({
      ANTHROPIC_API_KEY: { type: "secret_ref", secretId: "sec-1" },
    });

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

  it("omits the env key from the hire payload when there are no bindings", async () => {
    const { root } = await mount();

    const heartbeatButton = findButtonByText(document.body, "Give it a heartbeat");
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

  it("restores credentialBindings from a saved draft and merges them into the hire payload", async () => {
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

    const { root } = await mount();

    // The restored binding surfaces as a bound env key on the connect card.
    expect(
      document.body.querySelector('[data-testid="mock-credential-bind"]')
        ?.textContent,
    ).toBe("bound:ANTHROPIC_API_KEY");

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
      secretId: "sec-draft",
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("does not send a binding collected under a previously-selected adapter when hiring with a different adapter selected", async () => {
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
    window.localStorage.setItem(
      ONBOARDING_STORAGE_KEY,
      JSON.stringify({
        step: 4,
        agentName: "Chief of staff",
        adapterType: "gemini_local",
        // Stale binding left over from when claude_local was selected.
        credentialBindings: {
          ANTHROPIC_API_KEY: { type: "secret_ref", secretId: "sec-stale" },
        },
      }),
    );

    const { root } = await mount();

    const heartbeatButton = findButtonByText(document.body, "Give it a heartbeat");
    await act(async () => {
      heartbeatButton.click();
    });
    await flushReact();

    expect(mockAgentsApi.hire).toHaveBeenCalledTimes(1);
    const hirePayload = mockAgentsApi.hire.mock.calls[0]?.[1] as {
      adapterConfig: Record<string, unknown>;
    };
    // Filtered out entirely, and the base config has no env of its own, so
    // the regression-guarded "no env key when nothing is bound" behavior
    // holds even though credentialBindings isn't empty.
    expect(hirePayload.adapterConfig).not.toHaveProperty("env");

    await act(async () => {
      root.unmount();
    });
  });
});

describe("mergeCredentialBindings", () => {
  // Exercised indirectly above through the wizard's call sites; this
  // isolates the merge/filter semantics themselves since the helper isn't
  // exported (it's an internal implementation detail of the wizard), driven
  // through the same "restore saved draft" + hire path used elsewhere in
  // this file so the base-env-survives case doesn't need a real
  // buildAdapterConfig() with forceUnset wiring.
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
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("merges a matching binding on top of the base config's own env instead of replacing it", async () => {
    // Simulate buildAdapterConfig() already producing a base env entry (e.g.
    // the forceUnsetAnthropicApiKey plain-value marker) by having the
    // claude_local adapter's buildAdapterConfig stub return one.
    mockAdapterRegistry.byType.claude_local = {
      buildAdapterConfig: () => ({
        env: { ANTHROPIC_API_KEY: { type: "plain", value: "" } },
      }),
      credentialSetup: {
        options: [
          {
            envKey: "CLAUDE_CODE_OAUTH_TOKEN",
            label: "Claude Pro/Max subscription token",
            placeholder: "sk-ant-oat01-...",
          },
        ],
      },
    };
    window.localStorage.setItem(
      ONBOARDING_STORAGE_KEY,
      JSON.stringify({
        step: 4,
        agentName: "Chief of staff",
        adapterType: "claude_local",
        credentialBindings: {
          CLAUDE_CODE_OAUTH_TOKEN: { type: "secret_ref", secretId: "sec-token" },
        },
      }),
    );

    const { root } = await mount();

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
    expect(hirePayload.adapterConfig.env?.ANTHROPIC_API_KEY).toEqual({
      type: "plain",
      value: "",
    });
    // ...alongside the binding for the current adapter's credential option.
    expect(hirePayload.adapterConfig.env?.CLAUDE_CODE_OAUTH_TOKEN).toEqual({
      type: "secret_ref",
      secretId: "sec-token",
    });

    await act(async () => {
      root.unmount();
    });
  });
});
