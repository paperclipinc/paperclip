import { describe, expect, it } from "vitest";
import {
  normalizeExperimentalSettings,
  applyManagedExperienceEnvOverride,
} from "../services/instance-settings.js";

describe("instance settings service", () => {
  it("ignores retired experimental flags without resetting current settings", () => {
    expect(normalizeExperimentalSettings({
      enableEnvironments: true,
      enableIsolatedWorkspaces: true,
      enableIssuePlanDecompositions: true,
      enableExperimentalFileViewer: true,
      enableTaskWatchdogs: true,
      enableCloudSync: true,
      autoRestartDevServerWhenIdle: true,
      enableIssueGraphLivenessAutoRecovery: true,
      issueGraphLivenessAutoRecoveryLookbackHours: 48,
      enableNewestFirstIssueThread: true,
    })).toEqual({
      enableEnvironments: true,
      enableIsolatedWorkspaces: true,
      enableStreamlinedLeftNavigation: true,
      enableConferenceRoomChat: false,
      enableExternalObjects: false,
      enableIssuePlanDecompositions: true,
      enableExperimentalFileViewer: true,
      enableTaskWatchdogs: true,
      enableCloudSync: true,
      autoRestartDevServerWhenIdle: true,
      enableIssueGraphLivenessAutoRecovery: true,
      issueGraphLivenessAutoRecoveryLookbackHours: 48,
      managedExperience: false,
      cloudBilling: false,
    });
  });

  it("defaults enableConferenceRoomChat to false for empty and legacy stored settings", () => {
    expect(normalizeExperimentalSettings(undefined).enableConferenceRoomChat).toBe(false);
    expect(normalizeExperimentalSettings({}).enableConferenceRoomChat).toBe(false);
    // Rows persisted before the flag existed (PAP-137) must normalize to off.
    expect(
      normalizeExperimentalSettings({ enableStreamlinedLeftNavigation: true }).enableConferenceRoomChat,
    ).toBe(false);
  });

  it("defaults enableTaskWatchdogs to false for empty and legacy stored settings", () => {
    expect(normalizeExperimentalSettings(undefined).enableTaskWatchdogs).toBe(false);
    expect(normalizeExperimentalSettings({}).enableTaskWatchdogs).toBe(false);
    expect(
      normalizeExperimentalSettings({ enableExperimentalFileViewer: true }).enableTaskWatchdogs,
    ).toBe(false);
  });

  it("round-trips an enableConferenceRoomChat patch through the update merge", () => {
    // updateExperimental merges `{ ...normalize(current), ...patch }` and
    // re-normalizes; emulate that to prove the flag survives the roundtrip
    // without disturbing other settings.
    const current = normalizeExperimentalSettings({});
    const enabled = normalizeExperimentalSettings({ ...current, enableConferenceRoomChat: true });
    expect(enabled.enableConferenceRoomChat).toBe(true);
    expect(enabled.enableStreamlinedLeftNavigation).toBe(true);

    const disabled = normalizeExperimentalSettings({ ...enabled, enableConferenceRoomChat: false });
    expect(disabled).toEqual(current);
  });

  it("rejects non-boolean enableConferenceRoomChat values back to the default", () => {
    expect(
      normalizeExperimentalSettings({ enableConferenceRoomChat: "yes" }).enableConferenceRoomChat,
    ).toBe(false);
  });
});

describe("managedExperience flag", () => {
  it("defaults managedExperience to false", () => {
    expect(normalizeExperimentalSettings({}).managedExperience).toBe(false);
  });

  it("preserves an explicit managedExperience=true", () => {
    expect(
      normalizeExperimentalSettings({ managedExperience: true }).managedExperience,
    ).toBe(true);
  });

  it("env override forces managedExperience on", () => {
    const base = normalizeExperimentalSettings({});
    const out = applyManagedExperienceEnvOverride(base, {
      PAPERCLIP_MANAGED_EXPERIENCE: "true",
    });
    expect(out.managedExperience).toBe(true);
  });

  it("env override is a no-op when unset", () => {
    const base = normalizeExperimentalSettings({ managedExperience: false });
    expect(applyManagedExperienceEnvOverride(base, {}).managedExperience).toBe(false);
  });

  it("env override does not alter an already-true managedExperience", () => {
    const base = normalizeExperimentalSettings({ managedExperience: true });
    expect(
      applyManagedExperienceEnvOverride(base, { PAPERCLIP_MANAGED_EXPERIENCE: "true" }).managedExperience,
    ).toBe(true);
    expect(applyManagedExperienceEnvOverride(base, {}).managedExperience).toBe(true);
  });
});

describe("cloudBilling flag", () => {
  it("defaults cloudBilling to false", () => {
    expect(normalizeExperimentalSettings({}).cloudBilling).toBe(false);
    expect(normalizeExperimentalSettings(undefined).cloudBilling).toBe(false);
  });

  it("round-trips an explicit cloudBilling=true", () => {
    expect(normalizeExperimentalSettings({ cloudBilling: true }).cloudBilling).toBe(true);
  });

  it("rejects non-boolean cloudBilling back to the default", () => {
    expect(normalizeExperimentalSettings({ cloudBilling: "yes" }).cloudBilling).toBe(false);
  });

  it("env override PAPERCLIP_CLOUD_BILLING=true forces cloudBilling on", () => {
    const base = normalizeExperimentalSettings({});
    expect(applyManagedExperienceEnvOverride(base, { PAPERCLIP_CLOUD_BILLING: "true" }).cloudBilling).toBe(true);
  });

  it("env override leaves cloudBilling false when unset", () => {
    const base = normalizeExperimentalSettings({});
    expect(applyManagedExperienceEnvOverride(base, {}).cloudBilling).toBe(false);
  });
});
