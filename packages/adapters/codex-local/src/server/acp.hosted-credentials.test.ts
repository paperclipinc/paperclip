import { describe, expect, it } from "vitest";
import { testCodexAcpEnvironment } from "./acp.js";

// Regression guard for advice a hosted user cannot act on.
//
// The probe used to answer a missing credential with "Set OPENAI_API_KEY or run
// `codex login`". On a self-hosted install that is fine: the host is the user's
// own machine. On a hosted multi-tenant install it is a dead end, because the
// only shell that could run `codex login` belongs to the operator, and a
// customer who picked Codex expecting their ChatGPT plan to work followed that
// hint until they gave up and asked for a refund.
//
// `callerControlsHost: false` is how the server says "this person is a tenant,
// not the operator". These tests pin both branches: the tenant is told what
// they can actually do, and the self-hosted default keeps its old advice.

const baseConfig = {
  engine: "acp",
  // Deliberately not "codex": keeps the probe on the credential branch instead
  // of trying to resolve and spawn a real ACP server on the test machine.
  agentCommand: "/nonexistent/codex-acp",
  env: {},
};

describe("Codex ACP credential advice on a hosted install", () => {
  it("tells a tenant to add a key, never to run `codex login`", async () => {
    const result = await testCodexAcpEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: baseConfig,
      callerControlsHost: false,
    });

    const missing = result.checks.find((check) => check.code === "codex_acp_credentials_missing");
    expect(missing).toBeTruthy();
    expect(missing?.hint).toContain("Add an OpenAI API key");
    // The plan question is the one they actually arrived with. Leaving it
    // unanswered is what sent the customer looking for a route that is not there.
    expect(missing?.hint).toContain("ChatGPT Plus or Pro plan cannot be used here");
    // The old imperative must be gone. `codex login` may still be NAMED as the
    // reason a plan cannot work, but never issued as an instruction.
    expect(missing?.hint).not.toContain("Set OPENAI_API_KEY or run");
  });

  it("never reports the host's own credentials as the tenant's", async () => {
    // A credential in the operator's ~/.codex belongs to the operator or to
    // another tenant. Reporting it as "you are authenticated" would be worse
    // than unhelpful, so the hosted branch must not consult the host at all.
    const result = await testCodexAcpEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: baseConfig,
      callerControlsHost: false,
    });

    expect(result.checks.some((check) => check.code === "codex_acp_native_auth_detected")).toBe(false);
  });

  it("keeps the host-login advice for a self-hosted operator", async () => {
    // Default (field omitted) is the single-operator install, where the host
    // really is the user's machine and `codex login` is the right answer.
    const result = await testCodexAcpEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: { ...baseConfig, env: { CODEX_HOME: "/nonexistent/codex-home" } },
    });

    const missing = result.checks.find((check) => check.code === "codex_acp_credentials_missing");
    expect(missing).toBeTruthy();
    expect(missing?.hint).toContain("codex login");
  });

  it("says nothing about credentials when a key is configured", async () => {
    const result = await testCodexAcpEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: { ...baseConfig, env: { OPENAI_API_KEY: "sk-proj-test" } },
      callerControlsHost: false,
    });

    expect(result.checks.some((check) => check.code === "codex_acp_credentials_missing")).toBe(false);
    expect(
      result.checks.some((check) => check.code === "codex_acp_openai_api_key_detected"),
    ).toBe(true);
  });
});
