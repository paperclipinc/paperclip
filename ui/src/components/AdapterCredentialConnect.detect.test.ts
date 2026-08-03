import { describe, expect, it } from "vitest";
import type { AdapterCredentialSetup } from "@paperclipai/adapter-utils";
import { detectCredentialOptionIndex, normalizeCredentialValue } from "./AdapterCredentialConnect";

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

  it("detects a token corrupted by inner spaces (terminal line-wrap paste)", () => {
    expect(detectCredentialOptionIndex(options, "sk-ant-oat01-AbCdEf  GhIjKl")).toBe(1);
  });

  it("detects a token corrupted by an inner newline", () => {
    expect(detectCredentialOptionIndex(options, "sk-ant-api03-AbCdEf\nGhIjKl")).toBe(0);
  });

  it("normalizes a corrupted paste to the clean token (all whitespace removed)", () => {
    expect(normalizeCredentialValue("sk-ant-oat01-AbCdEf  GhIjKl")).toBe("sk-ant-oat01-AbCdEfGhIjKl");
    expect(normalizeCredentialValue("sk-ant-oat01-AbCdEf\nGhIjKl")).toBe("sk-ant-oat01-AbCdEfGhIjKl");
    expect(normalizeCredentialValue("  sk-ant-oat01-AbCdEfGhIjKl\n")).toBe("sk-ant-oat01-AbCdEfGhIjKl");
  });

  it("never routes an Anthropic key to a codex OPENAI_API_KEY option", () => {
    // Mirrors the codex-local credential setup: the lone OPENAI_API_KEY option
    // must reject sk-ant-… keys so handleConnect surfaces an error instead of
    // silently binding an Anthropic key (which fails every run with a 401).
    const codexOptions: AdapterCredentialSetup["options"] = [
      {
        envKey: "OPENAI_API_KEY",
        kind: "api_key",
        label: "OpenAI API key",
        valuePattern: "^sk-(?!ant-)[A-Za-z0-9_-]{20,}$",
      },
    ];
    expect(detectCredentialOptionIndex(codexOptions, "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz")).toBe(-1);
    expect(detectCredentialOptionIndex(codexOptions, "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789")).toBe(0);
  });

  it("ignores options without a valuePattern and never throws on a bad pattern", () => {
    const opts: AdapterCredentialSetup["options"] = [
      { envKey: "A", kind: "api_key", label: "A" },
      { envKey: "B", kind: "api_key", label: "B", valuePattern: "([" },
    ];
    expect(detectCredentialOptionIndex(opts, "anything")).toBe(-1);
  });
});

describe("normalizeCredentialValue on a file-shaped credential", () => {
  // Codex's auth.json is a whole file, and whitespace in a file is structure.
  // The key-shaped rule (strip every space and newline) happens to leave
  // today's auth.json parseable, because no token field contains a space. That
  // is luck, not correctness: one space inside any string value and the
  // credential is silently corrupted, surfacing as an unexplained auth failure
  // days later rather than as a rejected paste.
  const file = '{\n  "tokens": {\n    "account_id": "acct 1",\n    "refresh_token": "rt"\n  }\n}\n';

  it("preserves whitespace inside a multiline credential, trimming only the ends", () => {
    const normalized = normalizeCredentialValue(file, { multiline: true });
    expect(normalized).toBe(file.trim());
    expect(JSON.parse(normalized).tokens.account_id).toBe("acct 1");
  });

  it("still strips all whitespace from a key-shaped credential", () => {
    // Unchanged: a line-wrapped key from a terminal is a real failure mode and
    // stripping is the right repair there.
    expect(normalizeCredentialValue("sk-ant-oat01-AbCdEf\nGhIjKl")).toBe("sk-ant-oat01-AbCdEfGhIjKl");
    expect(normalizeCredentialValue("sk-ant-oat01-AbCdEf\nGhIjKl", { multiline: false })).toBe(
      "sk-ant-oat01-AbCdEfGhIjKl",
    );
  });

  it("would have corrupted a spaced value under the old rule", () => {
    // Guard on the specific regression, so nobody reinstates the blanket strip.
    const corrupted = file.replace(/\s+/g, "");
    expect(JSON.parse(corrupted).tokens.account_id).toBe("acct1");
    expect(normalizeCredentialValue(file, { multiline: true })).not.toBe(corrupted);
  });
});

