// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The mirror in telemetry.ts is what makes the cross-surface funnel work without
// instrumenting the onboarding wizard twice. Two things must hold: funnel-shaped
// events reach PostHog, and high-volume or sensitive ones do not.
const captureAnalytics = vi.fn();

vi.mock("./analytics", () => ({
  captureAnalytics,
  identifyUser: vi.fn(),
  initAnalytics: vi.fn(),
}));

async function loadTelemetry() {
  vi.resetModules();
  return import("./telemetry");
}

describe("telemetry -> PostHog mirror", () => {
  beforeEach(() => {
    captureAnalytics.mockClear();
    // initTelemetry() gates on /api/health reporting cloud mode, and reads it
    // off window.fetch specifically.
    window.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ deploymentMode: "authenticated" }),
    })) as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("mirrors wizard step transitions with their metadata", async () => {
    const { initTelemetry, trackStep, __resetTelemetryForTests } = await loadTelemetry();
    await initTelemetry();

    trackStep("onboarding", 3, 2, 4500);

    expect(captureAnalytics).toHaveBeenCalledWith(
      "onboarding_step",
      expect.objectContaining({ step: 3, prev_step: 2, ms_on_step: 4500 }),
    );
    __resetTelemetryForTests();
  });

  it("does not mirror before the tracker is installed", async () => {
    // Off-cloud installs never call initTelemetry, and nothing should reach
    // PostHog from a self-hosted deployment.
    const { trackStep } = await loadTelemetry();
    trackStep("onboarding", 1);
    expect(captureAnalytics).not.toHaveBeenCalled();
  });

  it("names events by surface so one project separates the funnels", async () => {
    const { initTelemetry, trackStep, __resetTelemetryForTests } = await loadTelemetry();
    await initTelemetry();

    trackStep("credential_connect", "validated");
    trackStep("billing", "trial_wall");

    const names = captureAnalytics.mock.calls.map(([name]) => name);
    expect(names).toContain("credential_connect_step");
    expect(names).toContain("billing_step");
    __resetTelemetryForTests();
  });
});
