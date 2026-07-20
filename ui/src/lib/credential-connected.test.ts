import { describe, expect, it } from "vitest";
import type { AdapterEnvironmentCheck, AdapterEnvironmentTestResult } from "@paperclipai/shared";
import {
  credentialFailureKey,
  credentialRejectionMessage,
  credentialSecretName,
  deriveCredentialConnected,
  findCredentialAuthFailureCheck,
  findMatchingCompanySecret,
} from "./credential-connected";

const setup = { options: [{ envKey: "ANTHROPIC_API_KEY" }, { envKey: "CLAUDE_CODE_OAUTH_TOKEN" }] } as never;
const secret = (
  key: string,
  status = "active",
  deletedAt: Date | null = null,
  id = "secret-id",
) => ({ id, key, status, deletedAt }) as never;

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

  it("does not match a free-text secret name that merely starts with the base", () => {
    // Secret keys are user-controlled free text. A secret named
    // "claude-local-anthropic-api-key-backup-notes" must not falsely count as
    // connected just because it starts with the canonical base name.
    const secrets = [secret("claude-local-anthropic-api-key-backup-notes")];
    expect(deriveCredentialConnected(setup, secrets, {}, "claude_local")).toBe(false);
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

  it("reads a failed envKey as not connected, even with a live session binding for it", () => {
    const bindings = { ANTHROPIC_API_KEY: { type: "secret_ref" as const, secretId: "abc" } };
    const failed = new Set([credentialFailureKey("claude_local", "ANTHROPIC_API_KEY")]);
    expect(deriveCredentialConnected(setup, [], bindings, "claude_local", failed)).toBe(false);
  });

  it("reads a failed envKey as not connected even when the server-side secret still exists", () => {
    // The secret can legitimately remain after a rejection (re-pasting the
    // corrected key reuses/suffixes the same name) — its mere presence must
    // not count as connected once the probe told us the value was rejected.
    // (In practice the caller also disables the secret server-side on
    // rejection specifically so this fallback can never see it as active
    // again after a reload — this test pins the client-side belt as well.)
    const secrets = [secret("claude-local-anthropic-api-key")];
    const failed = new Set([credentialFailureKey("claude_local", "ANTHROPIC_API_KEY")]);
    expect(deriveCredentialConnected(setup, secrets, {}, "claude_local", failed)).toBe(false);
  });

  it("still counts a different, unfailed envKey as connected", () => {
    const bindings = { CLAUDE_CODE_OAUTH_TOKEN: { type: "secret_ref" as const, secretId: "abc" } };
    const failed = new Set([credentialFailureKey("claude_local", "ANTHROPIC_API_KEY")]);
    expect(deriveCredentialConnected(setup, [], bindings, "claude_local", failed)).toBe(true);
  });

  it("does not let a rejection recorded under one adapter mark another adapter's independent binding of the same envKey as failed", () => {
    // ANTHROPIC_API_KEY is advertised by claude_local, opencode_local, and
    // pi_local independently (each has its own credential-setup.ts). A
    // rejection while onboarding claude_local must not disconnect
    // opencode_local's own, separately-bound ANTHROPIC_API_KEY.
    const bindings = { ANTHROPIC_API_KEY: { type: "secret_ref" as const, secretId: "opencode-secret" } };
    const failed = new Set([credentialFailureKey("claude_local", "ANTHROPIC_API_KEY")]);
    expect(deriveCredentialConnected(setup, [], bindings, "opencode_local", failed)).toBe(true);
    // Sanity check the other direction: the failure record DOES block the
    // adapter it was actually recorded against.
    expect(deriveCredentialConnected(setup, [], bindings, "claude_local", failed)).toBe(false);
  });
});

describe("findMatchingCompanySecret", () => {
  it("returns null with no secrets", () => {
    expect(findMatchingCompanySecret(setup, [], "claude_local")).toBeNull();
  });

  it("returns the envKey and secretId of the matching active secret", () => {
    const secrets = [secret("claude-local-anthropic-api-key", "active", null, "sec-42")];
    expect(findMatchingCompanySecret(setup, secrets, "claude_local")).toEqual({
      envKey: "ANTHROPIC_API_KEY",
      secretId: "sec-42",
    });
  });

  it("matches the -2 collision suffix", () => {
    const secrets = [secret("claude-local-anthropic-api-key-2", "active", null, "sec-suffix")];
    expect(findMatchingCompanySecret(setup, secrets, "claude_local")).toEqual({
      envKey: "ANTHROPIC_API_KEY",
      secretId: "sec-suffix",
    });
  });

  it("does not match a free-text secret name that merely starts with the base", () => {
    const secrets = [secret("claude-local-anthropic-api-key-backup-notes")];
    expect(findMatchingCompanySecret(setup, secrets, "claude_local")).toBeNull();
  });

  it("ignores disabled and deleted secrets", () => {
    expect(
      findMatchingCompanySecret(setup, [secret("claude-local-anthropic-api-key", "disabled")], "claude_local"),
    ).toBeNull();
    expect(
      findMatchingCompanySecret(
        setup,
        [secret("claude-local-anthropic-api-key", "active", new Date())],
        "claude_local",
      ),
    ).toBeNull();
  });

  it("ignores secrets belonging to a different adapter", () => {
    const secrets = [secret("codex-local-openai-api-key")];
    expect(findMatchingCompanySecret(setup, secrets, "claude_local")).toBeNull();
  });
});

function makeCheck(overrides: Partial<AdapterEnvironmentCheck> = {}): AdapterEnvironmentCheck {
  return {
    code: "some_check",
    level: "info",
    message: "message",
    ...overrides,
  };
}

function makeResult(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult {
  return {
    adapterType: "claude_local",
    status: "fail",
    checks,
    testedAt: new Date(0).toISOString(),
  };
}

describe("findCredentialAuthFailureCheck", () => {
  it("returns null for a null/undefined result", () => {
    expect(findCredentialAuthFailureCheck(null)).toBeNull();
    expect(findCredentialAuthFailureCheck(undefined)).toBeNull();
  });

  it("returns null when no check is flagged authFailure", () => {
    const result = makeResult([
      makeCheck({ code: "claude_cwd_valid", level: "info" }),
      makeCheck({ code: "claude_hello_probe_timed_out", level: "warn" }),
    ]);
    expect(findCredentialAuthFailureCheck(result)).toBeNull();
  });

  it("ignores a warn-level check even if it were somehow marked authFailure", () => {
    const result = makeResult([
      makeCheck({ code: "claude_hello_probe_auth_required", level: "warn", authFailure: true }),
    ]);
    expect(findCredentialAuthFailureCheck(result)).toBeNull();
  });

  it("finds the error-level check flagged authFailure", () => {
    const rejected = makeCheck({
      code: "claude_hello_probe_credential_rejected",
      level: "error",
      message: "Claude rejected the provided credential.",
      authFailure: true,
    });
    const result = makeResult([makeCheck({ code: "claude_cwd_valid" }), rejected]);
    expect(findCredentialAuthFailureCheck(result)).toBe(rejected);
  });

  it("does not match a generic error-level check without the authFailure flag", () => {
    const result = makeResult([
      makeCheck({ code: "claude_command_unresolvable", level: "error" }),
    ]);
    expect(findCredentialAuthFailureCheck(result)).toBeNull();
  });
});

describe("credentialRejectionMessage", () => {
  it("returns null for no check", () => {
    expect(credentialRejectionMessage(null)).toBeNull();
  });

  it("returns fixed plain-language copy, never the raw check detail", () => {
    const check = makeCheck({
      level: "error",
      message: "Claude rejected the provided credential.",
      detail: "API Error: 401 {\"type\":\"error\",\"error\":{\"type\":\"authentication_error\"}}",
      authFailure: true,
    });
    const message = credentialRejectionMessage(check);
    expect(message).toBe("That key was rejected by the provider. Check it and paste it again.");
    expect(message).not.toContain("401");
    expect(message).not.toContain("authentication_error");
  });
});
