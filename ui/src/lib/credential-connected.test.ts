import { describe, expect, it } from "vitest";
import { credentialSecretName, deriveCredentialConnected } from "./credential-connected";

const setup = { options: [{ envKey: "ANTHROPIC_API_KEY" }, { envKey: "CLAUDE_CODE_OAUTH_TOKEN" }] } as never;
const secret = (key: string, status = "active", deletedAt: Date | null = null) =>
  ({ key, status, deletedAt }) as never;

describe("credentialSecretName", () => {
  it("kebabs adapter type and env key", () => {
    expect(credentialSecretName("claude_local", "ANTHROPIC_API_KEY")).toBe("claude-local-anthropic-api-key");
  });
});

describe("deriveCredentialConnected", () => {
  it("is false with no secrets and no session bindings", () => {
    expect(deriveCredentialConnected(setup, [], {}, "claude_local")).toBe(false);
  });

  it("is true when the company has a matching active secret", () => {
    const secrets = [secret("claude-local-anthropic-api-key")];
    expect(deriveCredentialConnected(setup, secrets, {}, "claude_local")).toBe(true);
  });

  it("matches the -2 collision suffix", () => {
    const secrets = [secret("claude-local-anthropic-api-key-2")];
    expect(deriveCredentialConnected(setup, secrets, {}, "claude_local")).toBe(true);
  });

  it("ignores secrets belonging to a different adapter", () => {
    const secrets = [secret("codex-local-openai-api-key")];
    expect(deriveCredentialConnected(setup, secrets, {}, "claude_local")).toBe(false);
  });

  it("ignores disabled and deleted secrets", () => {
    expect(deriveCredentialConnected(setup, [secret("claude-local-anthropic-api-key", "disabled")], {}, "claude_local")).toBe(false);
    expect(deriveCredentialConnected(setup, [secret("claude-local-anthropic-api-key", "active", new Date())], {}, "claude_local")).toBe(false);
  });

  it("is true immediately after an in-session bind, before refetch", () => {
    const bindings = { ANTHROPIC_API_KEY: { type: "secret_ref" as const, secretId: "abc" } };
    expect(deriveCredentialConnected(setup, [], bindings, "claude_local")).toBe(true);
  });

  it("ignores a session binding for an env key this adapter does not use", () => {
    const bindings = { OPENAI_API_KEY: { type: "secret_ref" as const, secretId: "abc" } };
    expect(deriveCredentialConnected(setup, [], bindings, "claude_local")).toBe(false);
  });
});
