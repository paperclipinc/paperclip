import { describe, it, expect } from "vitest";
import { getAdapterDefaults, KNOWN_ADAPTER_TYPES } from "../../src/adapter-defaults.js";

describe("adapter-defaults", () => {
  it("returns defaults for claude_local", () => {
    const d = getAdapterDefaults("claude_local");
    expect(d.runtimeImage).toBe("ghcr.io/paperclipai/agent-runtime-claude:v1");
    expect(d.envKeys).toContain("ANTHROPIC_API_KEY");
    expect(d.allowFqdns).toContain("api.anthropic.com");
    expect(d.probeCommand).toEqual(["claude", "--version"]);
  });

  it("returns defaults for codex_local", () => {
    const d = getAdapterDefaults("codex_local");
    expect(d.runtimeImage).toBe("ghcr.io/paperclipai/agent-runtime-codex:v1");
    expect(d.envKeys).toContain("OPENAI_API_KEY");
    expect(d.probeCommand).toEqual(["codex", "--version"]);
  });

  it("allowlists the provider base-url env so a custom OpenAI-compatible endpoint can be set", () => {
    // Without the base-url key in envKeys it is stripped before the sandbox Job,
    // so the agent always hits the default public endpoint and cannot be routed
    // through a self-hosted / OpenAI-compatible gateway.
    expect(getAdapterDefaults("claude_local").envKeys).toContain("ANTHROPIC_BASE_URL");
    expect(getAdapterDefaults("codex_local").envKeys).toContain("OPENAI_BASE_URL");
    expect(getAdapterDefaults("opencode_local").envKeys).toEqual(
      expect.arrayContaining(["ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "OPENROUTER_BASE_URL"]),
    );
    expect(getAdapterDefaults("gemini_local").envKeys).toContain("GOOGLE_GEMINI_BASE_URL");
  });

  it("throws on unknown adapter type", () => {
    expect(() => getAdapterDefaults("nonexistent_local")).toThrow(/unknown adapter type/i);
  });

  it("KNOWN_ADAPTER_TYPES contains all 7 supported adapters", () => {
    expect(KNOWN_ADAPTER_TYPES).toEqual(
      new Set([
        "claude_local",
        "codex_local",
        "gemini_local",
        "cursor_local",
        "opencode_local",
        "acpx_local",
        "pi_local",
      ]),
    );
  });
});
