import { describe, expect, it } from "vitest";
import {
  resolveManagedAgentDefaults,
  applyManagedAgentDefaults,
} from "./managed-agent-defaults.js";

describe("resolveManagedAgentDefaults", () => {
  it("returns null when no managed adapter env is set", () => {
    expect(resolveManagedAgentDefaults({})).toBeNull();
  });

  it("reads adapter and model from env", () => {
    expect(
      resolveManagedAgentDefaults({
        PAPERCLIP_MANAGED_DEFAULT_ADAPTER: "opencode_local",
        PAPERCLIP_MANAGED_DEFAULT_MODEL: "anthropic/tensorix/deepseek/deepseek-v4-pro",
      }),
    ).toEqual({
      adapterType: "opencode_local",
      model: "anthropic/tensorix/deepseek/deepseek-v4-pro",
    });
  });

  it("model is null when only the adapter is set", () => {
    expect(
      resolveManagedAgentDefaults({ PAPERCLIP_MANAGED_DEFAULT_ADAPTER: "opencode_local" }),
    ).toEqual({ adapterType: "opencode_local", model: null });
  });
});

describe("applyManagedAgentDefaults", () => {
  const managed = {
    adapterType: "opencode_local",
    model: "anthropic/tensorix/deepseek/deepseek-v4-pro",
  };

  it("injects adapter + model when the request omits the adapter", () => {
    const out = applyManagedAgentDefaults({
      requestedAdapterType: undefined,
      adapterConfig: {},
      managed,
    });
    expect(out.adapterType).toBe("opencode_local");
    expect(out.adapterConfig.model).toBe(
      "anthropic/tensorix/deepseek/deepseek-v4-pro",
    );
  });

  it("does not override an explicitly chosen adapter (Advanced power user)", () => {
    const out = applyManagedAgentDefaults({
      requestedAdapterType: "codex_local",
      adapterConfig: {},
      managed,
    });
    expect(out.adapterType).toBe("codex_local");
    expect(out.adapterConfig.model).toBeUndefined();
  });

  it("does not override a model the user already supplied", () => {
    const out = applyManagedAgentDefaults({
      requestedAdapterType: undefined,
      adapterConfig: { model: "anthropic/tensorix/z-ai/glm-4.7" },
      managed,
    });
    expect(out.adapterConfig.model).toBe("anthropic/tensorix/z-ai/glm-4.7");
  });

  it("is a no-op when managed is null", () => {
    const out = applyManagedAgentDefaults({
      requestedAdapterType: undefined,
      adapterConfig: {},
      managed: null,
    });
    expect(out.adapterType).toBeUndefined();
    expect(out.adapterConfig).toEqual({});
  });
});
