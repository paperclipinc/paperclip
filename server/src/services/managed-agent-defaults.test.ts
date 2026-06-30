import { describe, expect, it } from "vitest";
import {
  resolveManagedAgentDefaults,
  applyManagedAgentDefaults,
  warnIfManagedExperienceMisconfigured,
  resolveManagedRunDefaults,
  overrideAgentForManagedRun,
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

describe("warnIfManagedExperienceMisconfigured", () => {
  it("returns a non-null message when flag=true and adapter is unset", () => {
    const result = warnIfManagedExperienceMisconfigured({
      PAPERCLIP_MANAGED_EXPERIENCE: "true",
    });
    expect(result).not.toBeNull();
    expect(result).toContain("PAPERCLIP_MANAGED_DEFAULT_ADAPTER");
  });

  it("returns null when flag=true and adapter is set", () => {
    const result = warnIfManagedExperienceMisconfigured({
      PAPERCLIP_MANAGED_EXPERIENCE: "true",
      PAPERCLIP_MANAGED_DEFAULT_ADAPTER: "opencode_local",
    });
    expect(result).toBeNull();
  });

  it("returns null when flag is unset", () => {
    const result = warnIfManagedExperienceMisconfigured({});
    expect(result).toBeNull();
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

  it("injects when adapterType is the schema default sentinel 'process'", () => {
    const out = applyManagedAgentDefaults({
      requestedAdapterType: "process",
      adapterConfig: {},
      managed,
    });
    expect(out.adapterType).toBe("opencode_local");
    expect(out.adapterConfig.model).toBe("anthropic/tensorix/deepseek/deepseek-v4-pro");
  });

  it("treats whitespace-only adapterType as unspecified", () => {
    const out = applyManagedAgentDefaults({
      requestedAdapterType: "   ",
      adapterConfig: {},
      managed,
    });
    expect(out.adapterType).toBe("opencode_local");
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

describe("resolveManagedRunDefaults", () => {
  it("returns null unless PAPERCLIP_MANAGED_EXPERIENCE=true", () => {
    expect(
      resolveManagedRunDefaults({
        PAPERCLIP_MANAGED_DEFAULT_ADAPTER: "opencode_local",
        PAPERCLIP_MANAGED_DEFAULT_MODEL: "z-ai/glm-5.2",
      }),
    ).toBeNull();
  });

  it("returns the managed defaults when managed experience is enabled", () => {
    expect(
      resolveManagedRunDefaults({
        PAPERCLIP_MANAGED_EXPERIENCE: "true",
        PAPERCLIP_MANAGED_DEFAULT_ADAPTER: "opencode_local",
        PAPERCLIP_MANAGED_DEFAULT_MODEL: "z-ai/glm-5.2",
      }),
    ).toEqual({ adapterType: "opencode_local", model: "z-ai/glm-5.2" });
  });
});

describe("overrideAgentForManagedRun", () => {
  const managed = { adapterType: "opencode_local", model: "z-ai/glm-5.2" };

  it("forces a stored codex_local agent onto the managed adapter + model", () => {
    const stored = {
      id: "a1",
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5-codex", reasoningEffort: "high" },
    };
    const out = overrideAgentForManagedRun(stored, managed);
    expect(out.adapterType).toBe("opencode_local");
    expect(out.adapterConfig.model).toBe("z-ai/glm-5.2");
    // does not mutate the stored row
    expect(stored.adapterType).toBe("codex_local");
    expect(stored.adapterConfig.model).toBe("gpt-5-codex");
  });

  it("is a no-op when managed is null (managed mode off)", () => {
    const stored = { adapterType: "codex_local", adapterConfig: { model: "gpt-5-codex" } };
    const out = overrideAgentForManagedRun(stored, null);
    expect(out).toBe(stored);
  });

  it("tolerates a null adapterConfig", () => {
    const stored = { adapterType: "claude_local", adapterConfig: null };
    const out = overrideAgentForManagedRun(stored, managed);
    expect(out.adapterType).toBe("opencode_local");
    expect(out.adapterConfig).toEqual({ model: "z-ai/glm-5.2" });
  });

  it("returns the same reference when already on the managed adapter + model", () => {
    const stored = { adapterType: "opencode_local", adapterConfig: { model: "z-ai/glm-5.2" } };
    const out = overrideAgentForManagedRun(stored, managed);
    expect(out).toBe(stored);
  });
});
