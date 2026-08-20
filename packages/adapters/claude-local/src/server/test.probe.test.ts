import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";

const {
  ensureAdapterExecutionTargetDirectory,
  ensureAdapterExecutionTargetCommandResolvable,
  maybeRunSandboxInstallCommand,
  runAdapterExecutionTargetProcess,
  describeAdapterExecutionTarget,
  resolveAdapterExecutionTargetCwd,
  probeResult,
  claudeCliUnresolvable,
} = vi.hoisted(() => {
  const probeResult: { value: { exitCode: number; stdout: string; stderr: string } } = {
    value: { exitCode: 1, stdout: "", stderr: "" },
  };
  // Command-aware toggle used only by the ACP-pipeline "probe cannot run"
  // test below: the ACP lane calls this resolvability check multiple times
  // for DIFFERENT commands in one testEnvironment() call (engine
  // resolution's own pre-check, testClaudeAcpEnvironment's ACP-server
  // command check, and the new credential probe's `claude` CLI check) — a
  // call-order-dependent mock would be fragile, so this rejects ONLY the
  // `claude` binary check specifically when enabled, leaving every other
  // command (including the CLI lane's own default `command: "claude"` in
  // every other test in this file) on the default always-succeeds path.
  const claudeCliUnresolvable: { value: boolean } = { value: false };
  return {
    probeResult,
    claudeCliUnresolvable,
    ensureAdapterExecutionTargetDirectory: vi.fn(async () => {}),
    ensureAdapterExecutionTargetCommandResolvable: vi.fn(async (command: string) => {
      if (claudeCliUnresolvable.value && command === "claude") {
        throw new Error("command not found on PATH: claude");
      }
    }),
    maybeRunSandboxInstallCommand: vi.fn(async () => null),
    runAdapterExecutionTargetProcess: vi.fn(async () => ({
      exitCode: probeResult.value.exitCode,
      signal: null,
      timedOut: false,
      stdout: probeResult.value.stdout,
      stderr: probeResult.value.stderr,
      pid: 123,
      startedAt: new Date().toISOString(),
    })),
    describeAdapterExecutionTarget: vi.fn(() => "Daytona"),
    resolveAdapterExecutionTargetCwd: vi.fn(() => "/home/daytona/paperclip-workspace"),
  };
});

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetDirectory,
    ensureAdapterExecutionTargetCommandResolvable,
    maybeRunSandboxInstallCommand,
    runAdapterExecutionTargetProcess,
    describeAdapterExecutionTarget,
    resolveAdapterExecutionTargetCwd,
  };
});

import { testEnvironment } from "./test.js";

const sandboxTarget: AdapterExecutionTarget = {
  kind: "remote",
  transport: "sandbox",
  providerKey: "daytona",
  remoteCwd: "/home/daytona/paperclip-workspace",
  runner: {
    execute: async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
      pid: null,
      startedAt: new Date().toISOString(),
    }),
  },
};

const initLine =
  '{"type":"system","subtype":"init","cwd":"/home/daytona/paperclip-workspace","session_id":"abc","tools":["Bash","Read"]}';

afterEach(() => {
  vi.clearAllMocks();
  claudeCliUnresolvable.value = false;
});

describe("claude sandbox hello probe diagnostics", () => {
  it("keeps the raw failure result out of every check and routes it to the log", async () => {
    // The non-zero result event carries a marker. The check must not repeat the
    // marker, and the redacted diagnostic must reach the server log.
    const marker = "NONPATTERNMARKERfailure";
    probeResult.value = {
      exitCode: 1,
      stdout: [
        initLine,
        `{"type":"result","subtype":"error_during_execution","is_error":true,"result":"API Error: 404 model not found ${marker}","session_id":"abc"}`,
      ].join("\n"),
      stderr: "",
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { engine: "cli", command: "claude", model: "claude-opus-4-8" },
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    expect(result.status).toBe("fail");
    const failed = result.checks.find((check) => check.code === "claude_hello_probe_failed");
    expect(failed).toBeTruthy();
    // The public check carries only a fixed message and hint, no raw detail.
    expect(failed?.detail).toBeUndefined();
    const checkText = JSON.stringify(result.checks);
    expect(checkText).not.toContain(marker);
    // The unhelpful init line must never reach a check either.
    expect(checkText).not.toContain('"subtype":"init"');
    // The raw diagnostic still reaches the server log.
    const loggedText = JSON.stringify(warnSpy.mock.calls);
    expect(loggedText).toContain(marker);
    warnSpy.mockRestore();
  });

  it("keeps a stdout-fallback failure line out of every check", async () => {
    // The CLI dies before a result event, so the last non-init stdout line is
    // the diagnostic. The check must not repeat its marker.
    const marker = "NONPATTERNMARKERstdout";
    probeResult.value = {
      exitCode: 1,
      stdout: [initLine, `fatal: claude crashed ${marker}`].join("\n"),
      stderr: "",
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { engine: "cli", command: "claude" },
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    const failed = result.checks.find((check) => check.code === "claude_hello_probe_failed");
    expect(failed).toBeTruthy();
    expect(failed?.detail).toBeUndefined();
    const checkText = JSON.stringify(result.checks);
    expect(checkText).not.toContain(marker);
    expect(checkText).not.toContain('"subtype":"init"');
    const loggedText = JSON.stringify(warnSpy.mock.calls);
    expect(loggedText).toContain(marker);
    warnSpy.mockRestore();
  });

  it("never copies a credential-bearing stderr failure line into a check", async () => {
    // A verbose CLI can print a credential to stderr on failure. The check must
    // not repeat it, and the server log must redact it.
    const secret = "sk-ant-STDERRLEAK0123456789abcdef";
    probeResult.value = {
      exitCode: 1,
      stdout: initLine,
      stderr: `fatal: request failed with token ${secret}`,
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { engine: "cli", command: "claude" },
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    const checkText = JSON.stringify(result.checks);
    expect(checkText).not.toContain(secret);
    expect(checkText).not.toContain("STDERRLEAK");
    const loggedText = JSON.stringify(warnSpy.mock.calls);
    expect(loggedText).not.toContain(secret);
    expect(loggedText).toContain("***REDACTED***");
    warnSpy.mockRestore();
  });

  it("keeps an auth-required probe marker out of every check", async () => {
    // The auth-required stdout and stderr carry a marker. The login-required
    // checks must not repeat it, and the login gate code must stay stable.
    const marker = "NONPATTERNMARKERauthcli";
    probeResult.value = {
      exitCode: 1,
      stdout: [
        initLine,
        `{"type":"result","subtype":"error_during_execution","is_error":true,"result":"Please run \`claude login\` ${marker}","session_id":"abc"}`,
      ].join("\n"),
      stderr: `Please run claude login ${marker}`,
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { engine: "cli", command: "claude" },
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    expect(result.checks.some((check) => check.code === "claude_hello_probe_auth_required")).toBe(true);
    // The login gate code stays stable so the user interface can offer login.
    expect(result.checks.some((check) => check.code === "adapter_auth_missing")).toBe(true);
    const checkText = JSON.stringify(result.checks);
    expect(checkText).not.toContain(marker);
    const loggedText = JSON.stringify(warnSpy.mock.calls);
    expect(loggedText).toContain(marker);
    warnSpy.mockRestore();
  });

  it("classifies an invalid or expired token as adapter_auth_missing without leaking the token", async () => {
    // Grounded on the real Claude CLI output for CLAUDE_CODE_OAUTH_TOKEN=invalid.
    // The probe exits non-zero and the result event reports a 401 authentication
    // failure with an "Invalid bearer token" message. A synthetic bearer marker
    // rides along on a retry line, so the test proves the raw text never reaches
    // a check.
    const marker = "SUPERSECRETbearerMARKERcli";
    probeResult.value = {
      exitCode: 1,
      stdout: [
        initLine,
        `{"type":"system","subtype":"api_retry","attempt":1,"error_status":401,"error":"authentication_failed: bearer ${marker} is invalid","session_id":"abc"}`,
        '{"type":"result","subtype":"success","is_error":true,"api_error_status":401,"error":"authentication_failed","result":"Failed to authenticate. API Error: 401 Invalid bearer token","session_id":"abc"}',
      ].join("\n"),
      stderr: "",
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { engine: "cli", command: "claude" },
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    // An auth failure returns the canonical login gate code, so the user
    // interface can offer login.
    expect(result.checks.some((check) => check.code === "claude_hello_probe_auth_required")).toBe(true);
    expect(result.checks.some((check) => check.code === "adapter_auth_missing")).toBe(true);
    // The raw probe text, including the bearer marker, never reaches a check.
    expect(JSON.stringify(result.checks)).not.toContain(marker);
    warnSpy.mockRestore();
  });

  it("does not flag a healthy probe whose assistant text repeats a token phrase", async () => {
    // A healthy run prints an auth phrase in its answer text. The parsed result
    // is a success, so the probe stays healthy and offers no login gate.
    probeResult.value = {
      exitCode: 0,
      stdout: [
        initLine,
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hello — authentication_failed means an invalid bearer token"}]},"session_id":"abc"}',
        '{"type":"result","subtype":"success","is_error":false,"result":"hello","session_id":"abc"}',
      ].join("\n"),
      stderr: "",
    };

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { engine: "cli", command: "claude" },
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    expect(result.checks.some((check) => check.code === "adapter_auth_missing")).toBe(false);
    expect(result.checks.some((check) => check.code === "claude_hello_probe_auth_required")).toBe(false);
    expect(result.checks.some((check) => check.code === "claude_hello_probe_passed")).toBe(true);
  });

  it("keeps a transient failure with an assistant token phrase off the login gate", async () => {
    // The probe fails on a 529 overload. The auth phrase appears only in the raw
    // stdout assistant event, not the parsed result, so the run stays transient
    // and never surfaces the login gate.
    probeResult.value = {
      exitCode: 1,
      stdout: [
        initLine,
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"authentication_failed: the bearer token is invalid"}]},"session_id":"abc"}',
        '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"API Error: 529 overloaded_error","session_id":"abc"}',
      ].join("\n"),
      stderr: "",
    };

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { engine: "cli", command: "claude" },
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    expect(result.checks.some((check) => check.code === "adapter_auth_missing")).toBe(false);
    expect(result.checks.some((check) => check.code === "claude_hello_probe_auth_required")).toBe(false);
    expect(result.checks.some((check) => check.code === "claude_hello_probe_transient_upstream")).toBe(true);
  });

  it("keeps an unexpected successful summary out of every check", async () => {
    // The probe exits 0 but does not return `hello`. The unexpected summary is
    // untrusted output. The check must not repeat its marker.
    const marker = "NONPATTERNMARKERunexpected";
    probeResult.value = {
      exitCode: 0,
      stdout: [
        initLine,
        `{"type":"result","subtype":"success","is_error":false,"result":"Here is something else ${marker}","session_id":"abc"}`,
      ].join("\n"),
      stderr: "",
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { engine: "cli", command: "claude" },
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    const unexpected = result.checks.find(
      (check) => check.code === "claude_hello_probe_unexpected_output",
    );
    expect(unexpected).toBeTruthy();
    expect(unexpected?.detail).toBeUndefined();
    const checkText = JSON.stringify(result.checks);
    expect(checkText).not.toContain(marker);
    const loggedText = JSON.stringify(warnSpy.mock.calls);
    expect(loggedText).toContain(marker);
    warnSpy.mockRestore();
  });

  it("classifies subscription usage-limit failures as a usage-limited warning, not a hard fail", async () => {
    probeResult.value = {
      exitCode: 1,
      stdout: [
        initLine,
        '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"Claude usage limit reached. Please try again later.","session_id":"abc"}',
      ].join("\n"),
      stderr: "",
    };

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { engine: "cli", command: "claude" },
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    expect(result.checks.some((check) => check.code === "claude_hello_probe_usage_limited")).toBe(true);
    expect(result.checks.some((check) => check.code === "claude_hello_probe_transient_upstream")).toBe(false);
    expect(result.checks.some((check) => check.code === "claude_hello_probe_failed")).toBe(false);
  });

  it("classifies overload failures as a transient warning, not a hard fail", async () => {
    probeResult.value = {
      exitCode: 1,
      stdout: [
        initLine,
        '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"API Error: 529 overloaded_error","session_id":"abc"}',
      ].join("\n"),
      stderr: "",
    };

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { engine: "cli", command: "claude" },
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    expect(result.checks.some((check) => check.code === "claude_hello_probe_transient_upstream")).toBe(true);
    expect(result.checks.some((check) => check.code === "claude_hello_probe_usage_limited")).toBe(false);
    expect(result.checks.some((check) => check.code === "claude_hello_probe_failed")).toBe(false);
  });

  it("keeps the failed check free of a detail when only the system/init line is present", async () => {
    probeResult.value = {
      exitCode: 1,
      stdout: initLine,
      stderr: "",
    };

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { engine: "cli", command: "claude" },
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    const failed = result.checks.find((check) => check.code === "claude_hello_probe_failed");
    expect(failed?.detail).toBeUndefined();
    expect(JSON.stringify(result.checks)).not.toContain('"subtype":"init"');
  });
});

describe("claude auth mode hints", () => {
  const successStdout = [
    initLine,
    '{"type":"result","subtype":"success","is_error":false,"result":"hello","session_id":"abc"}',
  ].join("\n");

  it("reports the configured subscription token for remote targets", async () => {
    probeResult.value = { exitCode: 0, stdout: successStdout, stderr: "" };

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: {
        engine: "cli",
        command: "claude",
        env: { CLAUDE_CODE_OAUTH_TOKEN: "oauth-test-token" },
      },
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    const hint = result.checks.find((check) => check.code === "claude_oauth_token_configured");
    expect(hint).toBeTruthy();
    expect(hint?.level).toBe("info");
    expect(hint?.detail).toContain("configured environment variables");
    expect(
      result.checks.some((check) => check.code === "claude_anthropic_api_key_overrides_subscription"),
    ).toBe(false);
  });

  it("keeps the API-key warning authoritative when both ANTHROPIC_API_KEY and the token are set", async () => {
    probeResult.value = { exitCode: 0, stdout: successStdout, stderr: "" };

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: {
        engine: "cli",
        command: "claude",
        env: {
          ANTHROPIC_API_KEY: "api-test-key",
          CLAUDE_CODE_OAUTH_TOKEN: "oauth-test-token",
        },
      },
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    expect(
      result.checks.some((check) => check.code === "claude_anthropic_api_key_overrides_subscription"),
    ).toBe(true);
    expect(result.checks.some((check) => check.code === "claude_oauth_token_configured")).toBe(false);
  });

  it("hard-fails an invalid just-pasted API key instead of the soft 'please log in' nudge", async () => {
    // This is the exact CLI message a just-bound, syntactically-plausible
    // but wrong Anthropic key produces: it happens to mention /login even
    // though the real problem is the key itself, not a missing session.
    probeResult.value = {
      exitCode: 1,
      stdout: initLine,
      stderr: "Invalid API key · Please run /login",
    };

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { engine: "cli", command: "claude" },
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    expect(result.status).toBe("fail");
    const rejected = result.checks.find((check) => check.code === "claude_hello_probe_credential_rejected");
    expect(rejected).toBeTruthy();
    expect(rejected?.level).toBe("error");
    expect(rejected?.authFailure).toBe(true);
    expect(result.checks.some((check) => check.code === "claude_hello_probe_auth_required")).toBe(false);
  });

  it("keeps the soft 'login required' warning for a genuine not-signed-in-yet prompt", async () => {
    probeResult.value = {
      exitCode: 1,
      stdout: initLine,
      stderr: "Please log in. Run `claude login` first.",
    };

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { engine: "cli", command: "claude" },
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    expect(result.status).toBe("warn");
    const authRequired = result.checks.find((check) => check.code === "claude_hello_probe_auth_required");
    expect(authRequired).toBeTruthy();
    expect(authRequired?.authFailure).toBeUndefined();
    expect(result.checks.some((check) => check.code === "claude_hello_probe_credential_rejected")).toBe(false);
  });

  it("flags authFailure on a raw 401/invalid x-api-key failure that never matches the login-prompt wording", async () => {
    probeResult.value = {
      exitCode: 1,
      stdout: initLine,
      stderr:
        'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
    };

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { engine: "cli", command: "claude" },
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    expect(result.status).toBe("fail");
    const failed = result.checks.find((check) => check.code === "claude_hello_probe_failed");
    expect(failed?.authFailure).toBe(true);
  });

  it("does not hard-fail on incidental 'unauthorized' substring noise unrelated to the login prompt", async () => {
    // Pins the tightened CLAUDE_CREDENTIAL_REJECTED_RE at the full pipeline
    // level: requiresLogin still fires (CLAUDE_AUTH_REQUIRED_RE's bare
    // "unauthorized" alternative is unchanged, pre-existing behavior), but
    // credentialRejected must not, so this stays the existing soft "please
    // log in" warning rather than a hard authFailure.
    probeResult.value = {
      exitCode: 1,
      stdout: initLine,
      stderr: "Fetching https://api.example.com/orders?status=unauthorized_pending",
    };

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { engine: "cli", command: "claude" },
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    const authRequired = result.checks.find((check) => check.code === "claude_hello_probe_auth_required");
    expect(authRequired).toBeTruthy();
    expect(authRequired?.authFailure).toBeUndefined();
    expect(result.checks.some((check) => check.code === "claude_hello_probe_credential_rejected")).toBe(
      false,
    );
  });

  it("documents a false negative: an unrecognized rejection wording ('token revoked') still fails overall but without the authFailure flag", async () => {
    // The probe still hard-fails (a real error card shows up in the
    // "Adapter environment check" panel), but because the wording matches
    // none of our credential-rejection patterns, the authFailure-driven
    // gate-closing behavior in OnboardingWizard does not kick in for this
    // specific wording. A known, documented false-negative surface — not a
    // crash, and not silently reported as passing.
    probeResult.value = {
      exitCode: 1,
      stdout: initLine,
      stderr: "Your token has been revoked.",
    };

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { engine: "cli", command: "claude" },
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    expect(result.status).toBe("fail");
    const failed = result.checks.find((check) => check.code === "claude_hello_probe_failed");
    expect(failed).toBeTruthy();
    expect(failed?.authFailure).toBeUndefined();
  });
});

// Pipeline-level pin for the staging bug: onboarding never sends an
// explicit `engine`, and the default resolves to ACP (see
// resolveClaudeExecutionEngineForRun in acp.ts) whenever the sandbox has a
// bidirectional process target (sandboxTarget, reused from above, has a
// `runner`). Before the ACP lane grew its own live credential probe, this
// exact entrypoint — the one the server route actually calls — could never
// produce an authFailure check for ANY credential, valid or not: it just
// emitted static info/warn checks and said "Passed". These tests exercise
// the real production call path (testEnvironment, no explicit engine) end
// to end, not just the internal testClaudeAcpEnvironment/acp.ts unit level
// (see acp.probe.test.ts for those).
describe("Claude ACP lane via the shared testEnvironment entrypoint (no explicit engine)", () => {
  it("hard-fails a rejected credential end to end through the default ACP path", async () => {
    probeResult.value = {
      exitCode: 1,
      stdout: initLine,
      stderr: "Invalid API key · Please run /login",
    };

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { command: "claude", env: { ANTHROPIC_API_KEY: "sk-ant-api03-invalid" } },
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    expect(result.status).toBe("fail");
    const rejected = result.checks.find(
      (check) => check.code === "claude_hello_probe_credential_rejected",
    );
    expect(rejected).toBeTruthy();
    expect(rejected?.authFailure).toBe(true);
    // Sanity check this really took the ACP path, not a CLI fallback.
    expect(result.checks.some((check) => check.code === "claude_engine_selected")).toBe(true);
  });

  it("passes a valid credential end to end through the default ACP path", async () => {
    probeResult.value = {
      exitCode: 0,
      stdout: [
        initLine,
        '{"type":"result","subtype":"success","is_error":false,"result":"hello","session_id":"abc"}',
      ].join("\n"),
      stderr: "",
    };

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { command: "claude", env: { ANTHROPIC_API_KEY: "sk-ant-api03-valid" } },
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    const passed = result.checks.find((check) => check.code === "claude_hello_probe_passed");
    expect(passed).toBeTruthy();
    expect(result.checks.some((check) => check.authFailure)).toBe(false);
  });

  it("stays permissive when the probe cannot run (claude CLI not resolvable), through the default ACP path", async () => {
    // Command-aware, not call-order-dependent: this rejects ONLY the
    // credential probe's own `claude` CLI resolvability check. The
    // pre-existing ACP-server command check (agentCommand,
    // "/opt/claude-agent-acp") is a different command string and keeps
    // resolving normally, so only the NEW probe-gating logic is exercised.
    claudeCliUnresolvable.value = true;

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: {
        command: "claude",
        agentCommand: "/opt/claude-agent-acp",
        env: { ANTHROPIC_API_KEY: "sk-ant-api03-something" },
      },
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    expect(result.status).not.toBe("fail");
    const unavailable = result.checks.find(
      (check) => check.code === "claude_acp_credential_probe_unavailable",
    );
    expect(unavailable).toBeTruthy();
    expect(unavailable?.level).toBe("warn");
    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });
});
