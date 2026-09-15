import { describe, expect, it } from "vitest";
import { decideBundledPluginAction } from "./bundled-plugin-heal.js";

describe("decideBundledPluginAction", () => {
  it("installs when the plugin is not in the DB and the bundle is present", () => {
    expect(
      decideBundledPluginAction({ existingStatus: null, bundlePresent: true }),
    ).toBe("install");
  });

  it("skips silently when not in the DB and the bundle is absent", () => {
    expect(
      decideBundledPluginAction({ existingStatus: undefined, bundlePresent: false }),
    ).toBe("skip-bundle-missing");
  });

  it("does nothing when already ready (loadAll activates it)", () => {
    expect(
      decideBundledPluginAction({ existingStatus: "ready", bundlePresent: true }),
    ).toBe("skip-ready");
  });

  it("respects an explicit uninstall", () => {
    expect(
      decideBundledPluginAction({ existingStatus: "uninstalled", bundlePresent: true }),
    ).toBe("skip-uninstalled");
  });

  it("self-heals a plugin stuck in 'error' when the bundle is present", () => {
    expect(
      decideBundledPluginAction({ existingStatus: "error", bundlePresent: true }),
    ).toBe("self-heal");
  });

  it("self-heals 'installed', 'disabled' and 'upgrade_pending' too", () => {
    for (const status of ["installed", "disabled", "upgrade_pending"]) {
      expect(
        decideBundledPluginAction({ existingStatus: status, bundlePresent: true }),
      ).toBe("self-heal");
    }
  });

  it("cannot self-heal a stuck plugin when the bundle is missing", () => {
    expect(
      decideBundledPluginAction({ existingStatus: "error", bundlePresent: false }),
    ).toBe("self-heal-blocked-bundle-missing");
  });
});
