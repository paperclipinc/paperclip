// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
<<<<<<< HEAD
import { OnboardingWizardVariant } from "./OnboardingWizardVariant";

const mockAccessApi = vi.hoisted(() => ({
  getCurrentBoardAccess: vi.fn(),
}));

vi.mock("@/api/access", () => ({
  accessApi: mockAccessApi,
}));

vi.mock("./OnboardingWizard", () => ({
  OnboardingWizard: () => <div data-testid="wizard-capsule" />,
}));

describe("OnboardingWizardVariant (PAP-138)", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  function renderVariant() {
=======

// The shell reads dialog + company state and renders CloudOnboardingFlow. Mock those
// so the test exercises the shell's gating + option→prop mapping in isolation.
const dialogState = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("@/context/DialogContext", () => ({
  useDialog: () => dialogState.value,
}));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [{ id: "c1", issuePrefix: "ACME", name: "Acme" }],
    loading: false,
  }),
}));
vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: "/dashboard" }),
  useParams: () => ({}),
}));
vi.mock("./onboarding/CloudOnboardingFlow", () => ({
  CloudOnboardingFlow: (props: { initialStep?: string; existingCompany?: { id: string } }) => (
    <div
      data-testid="onboarding-flow"
      data-initial-step={props.initialStep}
      data-company={props.existingCompany?.id ?? ""}
    />
  ),
}));

import { OnboardingWizardVariant } from "./OnboardingWizardVariant";

function baseDialog(overrides: Record<string, unknown> = {}) {
  return {
    onboardingOpen: false,
    onboardingOptions: {},
    closeOnboarding: vi.fn(),
    onboardingRouteDismissed: true,
    setOnboardingRouteDismissed: vi.fn(),
    ...overrides,
  };
}

describe("OnboardingWizardVariant", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  function render() {
>>>>>>> origin/master
    root = createRoot(container);
    flushSync(() => {
      root!.render(<OnboardingWizardVariant />);
    });
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    flushSync(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
    vi.clearAllMocks();
  });

<<<<<<< HEAD
  it("renders the capsule wizard without reading the chat flag", () => {
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({});
    renderVariant();

    expect(container.querySelector('[data-testid="wizard-capsule"]')).not.toBeNull();
    expect(mockAccessApi.getCurrentBoardAccess).not.toHaveBeenCalled();
=======
  it("renders nothing when onboarding is closed", () => {
    dialogState.value = baseDialog();
    render();
    expect(container.querySelector('[data-testid="onboarding-flow"]')).toBeNull();
  });

  it("renders the flow at the start step for a fresh open", () => {
    dialogState.value = baseDialog({ onboardingOpen: true, onboardingOptions: {} });
    render();
    const el = container.querySelector('[data-testid="onboarding-flow"]');
    expect(el).not.toBeNull();
    expect(el?.getAttribute("data-initial-step")).toBe("start");
    expect(el?.getAttribute("data-company")).toBe("");
  });

  it("starts at the agent step with the company preset when adding to an existing company", () => {
    dialogState.value = baseDialog({
      onboardingOpen: true,
      onboardingOptions: { initialStep: 2, companyId: "c1" },
    });
    render();
    const el = container.querySelector('[data-testid="onboarding-flow"]');
    expect(el?.getAttribute("data-initial-step")).toBe("agent");
    expect(el?.getAttribute("data-company")).toBe("c1");
>>>>>>> origin/master
  });
});
