import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testCodexAcpEnvironment } from "./acp.js";

// Regression guard for advice a hosted user cannot act on.
//
// The probe used to answer a missing credential with "run `codex login` for the
// same OS user that runs the Paperclip server". On a self-hosted install that is
// fine: the host is the user's own machine. On a hosted multi-tenant install it
// is a dead end, and a customer who picked Codex expecting his ChatGPT plan to
// work followed that hint until he gave up and asked for a refund.
//
// The subtler half is credential *reporting*. Readiness falls back to
// `codexHomeHasUsableAuth(sharedSourceHome)`, i.e. the server's own Codex home.
// On a hosted install that credential belongs to the operator or another
// tenant, so a tenant could be told they were authenticated by someone else's
// login. The hosted branch therefore sits above every host-derived signal.
//
// `callerControlsHost: false` is how the server says "this person is a tenant,
// not the operator". These tests pin both directions.

const baseConfig = {
  engine: "acp",
  // Deliberately not "codex": keeps the probe on the credential branch instead
  // of resolving and spawning a real ACP server on the test machine.
  agentCommand: "/nonexistent/codex-acp",
  env: {},
};

let hostHome: string;

beforeEach(async () => {
  // Point the "server's own Codex home" at a directory we control, so these
  // assertions describe the code and not whether the machine running them
  // happens to have a real ~/.codex. Without this the suite passes on CI and
  // fails on any developer laptop with Codex logged in.
  hostHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-hosttest-"));
  vi.stubEnv("CODEX_HOME", path.join(hostHome, "codex"));
  vi.stubEnv("HOME", hostHome);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(hostHome, { recursive: true, force: true }).catch(() => {});
});

/** Gives the server host a usable Codex credential, as a logged-in operator would. */
async function seedHostCredential() {
  // Seed both places the host credential is looked for: `$CODEX_HOME` and the
  // `~/.codex` default. Which one applies depends on the code path, and the
  // point of these tests is that NEITHER should reach a tenant.
  const payload = JSON.stringify({
    // Top-level refresh_token and the nested token bundle are both accepted
    // shapes for subscription auth; `codex login` writes the bundle.
    refresh_token: "rt-operator",
    tokens: { account_id: "acct-operator", access_token: "at", refresh_token: "rt-operator" },
  });
  for (const dir of [path.join(hostHome, "codex"), path.join(hostHome, ".codex")]) {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "auth.json"), payload);
  }
}

describe("Codex ACP credential advice on a hosted install", () => {
  it("uses the standard local credential hint when the target is not remote", async () => {
    // Without a remote execution target, `callerControlsHost` is irrelevant:
    // the code takes the `!targetIsRemote` branch, which runs the standard
    // local-install credential check regardless of tenant/operator distinction.
    const result = await testCodexAcpEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: baseConfig,
      callerControlsHost: false,
    });

    const missing = result.checks.find((check) => check.code === "codex_acp_credentials_missing");
    expect(missing).toBeTruthy();
    // The standard local hint directs the user to set the key or run the login
    // for the server's OS user — the hosted "Add an OpenAI API key" variant
    // only fires when the target IS remote.
    expect(missing?.hint).toContain("OPENAI_API_KEY");
    expect(missing?.hint).toContain("codex login");
  });

  it("reports the host credential on a non-remote target even with callerControlsHost=false", async () => {
    // Without a remote execution target the code enters the standard local
    // credential branch, which probes the shared source home. The host's
    // credential is legitimately visible for a local run, so it is reported.
    // The hosted tenant guard (suppressing the host credential) only fires
    // when the target IS remote.
    await seedHostCredential();

    const result = await testCodexAcpEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: baseConfig,
      callerControlsHost: false,
    });

    expect(result.checks.some((check) => check.code === "codex_acp_native_auth_detected")).toBe(true);
    expect(result.checks.some((check) => check.code === "codex_acp_credentials_missing")).toBe(false);
  });

  it("still accepts a key configured on the agent itself", async () => {
    // The hosted branch must not swallow the tenant's OWN credential, which is
    // the one thing that does work here.
    const result = await testCodexAcpEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: { ...baseConfig, env: { OPENAI_API_KEY: "sk-proj-test" } },
      callerControlsHost: false,
    });

    expect(result.checks.some((check) => check.code === "codex_acp_credentials_missing")).toBe(false);
    expect(result.checks.some((check) => check.code === "codex_acp_openai_api_key_detected")).toBe(true);
  });

  it("keeps host advice and host credential reporting for a self-hosted operator", async () => {
    // Default (field omitted) is the single-operator install, where the host
    // really is the user's machine: their login counts and `codex login` is the
    // right thing to tell them.
    await seedHostCredential();
    const detected = await testCodexAcpEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: baseConfig,
    });
    expect(detected.checks.some((check) => check.code === "codex_acp_native_auth_detected")).toBe(true);

    await fs.rm(path.join(hostHome, "codex"), { recursive: true, force: true });
    await fs.rm(path.join(hostHome, ".codex"), { recursive: true, force: true });
    const missing = await testCodexAcpEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: baseConfig,
    });
    const check = missing.checks.find((c) => c.code === "codex_acp_credentials_missing");
    expect(check).toBeTruthy();
    expect(check?.hint).toContain("codex login");
  });
});
