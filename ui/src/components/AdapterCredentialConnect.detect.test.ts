import { describe, expect, it } from "vitest";
import type { AdapterCredentialSetup } from "@paperclipai/adapter-utils";
import { detectCredentialOptionIndex } from "./AdapterCredentialConnect";

// Mirrors the claude-local credential setup: an API key vs a subscription token,
// disambiguated by the sk-ant-api… / sk-ant-oat… prefix.
const options: AdapterCredentialSetup["options"] = [
  { envKey: "ANTHROPIC_API_KEY", kind: "api_key", label: "Anthropic API key", valuePattern: "^sk-ant-api" },
  { envKey: "CLAUDE_CODE_OAUTH_TOKEN", kind: "subscription_token", label: "Claude Pro/Max subscription token", valuePattern: "^sk-ant-oat" },
];

describe("detectCredentialOptionIndex", () => {
  it("routes a subscription OAuth token to CLAUDE_CODE_OAUTH_TOKEN, not the API key", () => {
    expect(detectCredentialOptionIndex(options, "sk-ant-oat01-AbCdEf...")).toBe(1);
  });

  it("routes a real API key to ANTHROPIC_API_KEY", () => {
    expect(detectCredentialOptionIndex(options, "sk-ant-api03-XyZ...")).toBe(0);
  });

  it("returns -1 for an empty/unrecognized value (no auto-switch)", () => {
    expect(detectCredentialOptionIndex(options, "")).toBe(-1);
    expect(detectCredentialOptionIndex(options, "   ")).toBe(-1);
    expect(detectCredentialOptionIndex(options, "hunter2")).toBe(-1);
  });

  it("trims surrounding whitespace before matching (pasted values)", () => {
    expect(detectCredentialOptionIndex(options, "  sk-ant-oat01-token\n")).toBe(1);
  });

  it("ignores options without a valuePattern and never throws on a bad pattern", () => {
    const opts: AdapterCredentialSetup["options"] = [
      { envKey: "A", kind: "api_key", label: "A" },
      { envKey: "B", kind: "api_key", label: "B", valuePattern: "([" },
    ];
    expect(detectCredentialOptionIndex(opts, "anything")).toBe(-1);
  });
});
