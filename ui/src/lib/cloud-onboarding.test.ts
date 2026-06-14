// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  hasCompletedCloudOnboarding,
  markCloudOnboardingComplete,
  shouldOpenCloudOnboarding,
} from "./cloud-onboarding";

describe("cloud first-run onboarding tracking", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it("opens once in cloud (authenticated) mode for an existing company", () => {
    expect(
      shouldOpenCloudOnboarding({
        deploymentMode: "authenticated",
        companyId: "company-1",
      }),
    ).toBe(true);
  });

  it("does not open after completion is marked", () => {
    markCloudOnboardingComplete("company-1");
    expect(hasCompletedCloudOnboarding("company-1")).toBe(true);
    expect(
      shouldOpenCloudOnboarding({
        deploymentMode: "authenticated",
        companyId: "company-1",
      }),
    ).toBe(false);
  });

  it("tracks completion per company id", () => {
    markCloudOnboardingComplete("company-1");
    expect(hasCompletedCloudOnboarding("company-1")).toBe(true);
    expect(hasCompletedCloudOnboarding("company-2")).toBe(false);
    expect(
      shouldOpenCloudOnboarding({
        deploymentMode: "authenticated",
        companyId: "company-2",
      }),
    ).toBe(true);
  });

  it("never opens outside cloud (authenticated) mode", () => {
    for (const deploymentMode of ["local", "single", undefined]) {
      expect(
        shouldOpenCloudOnboarding({ deploymentMode, companyId: "company-1" }),
      ).toBe(false);
    }
  });

  it("never opens without a company id", () => {
    expect(
      shouldOpenCloudOnboarding({
        deploymentMode: "authenticated",
        companyId: null,
      }),
    ).toBe(false);
  });
});
