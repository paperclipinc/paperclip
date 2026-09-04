import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  asString,
  asBoolean,
  asNumber,
  asStringArray,
  parseObject,
  ensurePathInEnv,
} from "@paperclipai/adapter-utils/server-utils";
import {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetDirectory,
  maybeRunSandboxInstallCommand,
  prepareAdapterExecutionTargetRuntime,
  describeAdapterExecutionTarget,
  resolveAdapterExecutionTargetCwd,
  resolveAdapterExecutionTargetCommandForLogs,
} from "@paperclipai/adapter-utils/execution-target";
import {
  claudeCliVersionAtLeast,
  claudeCommandLooksLike,
  minimumClaudeCliVersionForModel,
  readClaudeCommandVersion,
} from "./cli-capabilities.js";
import { isBedrockModelId } from "./models.js";
import { materializeRemoteClaudeConfig, prepareClaudeConfigSeed, prepareSandboxClaudeProbeRuntime } from "./claude-config.js";
import { runClaudeCredentialHelloProbe } from "./hello-probe.js";
import { SANDBOX_INSTALL_COMMAND } from "../index.js";
import { resolveClaudeExecutionEngineForRun, testClaudeAcpEnvironment } from "./acp.js";
import { ADAPTER_AUTH_MISSING_CHECK_CODE } from "./auth-check.js";
import {
  buildAdapterTestTargetCheck,
  buildClaudeLoginRequiredHint,
  logSandboxProbeDiagnostic,
} from "./probe-diagnostics.js";
import { buildLocalAdapterTestProbeEnv } from "./probe-env.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function localExecutablesMatch(
  trustedCommand: string | null,
  runtimeCommand: string | null,
): boolean {
  if (!trustedCommand || !runtimeCommand) return false;
  return trustedCommand === runtimeCommand;
}

// Pure decision for the (non-Bedrock) auth advice check: given the adapter's
// config env, is there a recognizable auth signal beyond ANTHROPIC_API_KEY
// (handled by the caller) that we should surface to the operator? Extracted
// so the CLAUDE_CODE_OAUTH_TOKEN detection contract can be unit tested
// without exercising the full probe pipeline.
export function resolveClaudeAuthAdvice(env: Record<string, unknown>): AdapterEnvironmentCheck | null {
  if (isNonEmpty(env.ANTHROPIC_API_KEY)) return null;
  if (isNonEmpty(env.CLAUDE_CODE_OAUTH_TOKEN)) {
    return {
      code: "claude_subscription_token_detected",
      level: "info",
      message:
        "CLAUDE_CODE_OAUTH_TOKEN is set; Claude will authenticate with the configured subscription token.",
    };
  }
  return null;
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const engineSelection = await resolveClaudeExecutionEngineForRun({
    config: parseObject(ctx.config),
    executionTarget: ctx.executionTarget,
  });
  if (engineSelection.engine === "acp") {
    return testClaudeAcpEnvironment(ctx);
  }

  const checks: AdapterEnvironmentCheck[] = [];
  if (!engineSelection.explicit && engineSelection.fallbackReason) {
    checks.push({
      code: "claude_acp_default_fallback",
      level: "warn",
      message: "Claude ACP default is unavailable; testing the Claude CLI fallback lane.",
      detail: engineSelection.fallbackReason,
      hint: "Fix the ACP prerequisite to use the default ACP lane, or set engine=cli to pin the CLI lane.",
    });
  }
  const config = parseObject(ctx.config);
  const command = asString(config.command, "claude");
  const target = ctx.executionTarget ?? null;
  const targetIsRemote = target?.kind === "remote";
  const callerControlsHost = ctx.callerControlsHost !== false;
  const targetIsSandbox = target?.kind === "remote" && target.transport === "sandbox";
  const cwd = resolveAdapterExecutionTargetCwd(target, asString(config.cwd, ""), process.cwd());
  const runId = `claude-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  // Always name the target the Test probed, so a pass result never hides which
  // target it checked. A local probe reports the fixed host label.
  checks.push(
    buildAdapterTestTargetCheck({ targetIsRemote, environmentName: ctx.environmentName }),
  );

  try {
    await ensureAdapterExecutionTargetDirectory(runId, target, cwd, {
      cwd,
      env: {},
      createIfMissing: true,
    });
    checks.push({
      code: "claude_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "claude_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  // For a local probe, resolve the trusted `claude` executable and a
  // deny-by-default child env from the shared builder, so a hostile caller
  // value can neither select the executable nor reach the child. A remote
  // target keeps the caller command and env; the remote transport owns its own
  // env sanitization.
  const localProbe = targetIsRemote
    ? null
    : await buildLocalAdapterTestProbeEnv({ callerEnv: env, trustedEnv: process.env });
  checks.push(
    ...(await prepareSandboxClaudeProbeRuntime({
      runId,
      target,
      cwd,
      companyId: ctx.companyId,
      env,
      installCommand: SANDBOX_INSTALL_COMMAND,
      detectCommand: command,
      targetIsRemote,
      targetIsSandbox,
      helloProbeTimeoutSec: asNumber(config.helloProbeTimeoutSec, targetIsSandbox ? 90 : 45),
    })),
  );
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  let localRuntimeCommand: string | null = null;
  try {
    await ensureAdapterExecutionTargetCommandResolvable(command, target, cwd, runtimeEnv);
    if (!targetIsRemote) {
      localRuntimeCommand = await resolveAdapterExecutionTargetCommandForLogs(
        command,
        target,
        cwd,
        runtimeEnv,
      );
    }
    checks.push({
      code: "claude_command_resolvable",
      level: "info",
      message: `Command is executable: ${command}`,
    });
  } catch (err) {
    checks.push({
      code: "claude_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
    });
  }

  // When probing a remote target, the Paperclip host's process.env does not
  // reflect what the agent will actually see at runtime. Only consider env
  // vars from the adapter config in that case; the probe itself will surface
  // any auth issues on the remote box.
  const considerHostEnv = !targetIsRemote;
  const hasBedrock =
    env.CLAUDE_CODE_USE_BEDROCK === "1" ||
    env.CLAUDE_CODE_USE_BEDROCK === "true" ||
    (considerHostEnv && process.env.CLAUDE_CODE_USE_BEDROCK === "1") ||
    (considerHostEnv && process.env.CLAUDE_CODE_USE_BEDROCK === "true") ||
    isNonEmpty(env.ANTHROPIC_BEDROCK_BASE_URL) ||
    (considerHostEnv && isNonEmpty(process.env.ANTHROPIC_BEDROCK_BASE_URL));

  const configApiKey = env.ANTHROPIC_API_KEY;
  const hostApiKey = considerHostEnv ? process.env.ANTHROPIC_API_KEY : undefined;
  if (hasBedrock) {
    const source =
      env.CLAUDE_CODE_USE_BEDROCK === "1" ||
      env.CLAUDE_CODE_USE_BEDROCK === "true" ||
      isNonEmpty(env.ANTHROPIC_BEDROCK_BASE_URL)
        ? "adapter config env"
        : "server environment";
    checks.push({
      code: "claude_bedrock_auth",
      level: "info",
      message: "AWS Bedrock auth detected. Claude will use Bedrock for inference.",
      detail: `Detected in ${source}.`,
      hint: "Ensure AWS credentials (AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY or AWS_PROFILE) and AWS_REGION are configured.",
    });
  } else if (isNonEmpty(configApiKey) || isNonEmpty(hostApiKey)) {
    const source = isNonEmpty(configApiKey) ? "adapter config env" : "server environment";
    checks.push({
      code: "claude_anthropic_api_key_overrides_subscription",
      level: "warn",
      message:
        "ANTHROPIC_API_KEY is set. Claude will use API-key auth instead of subscription credentials.",
      detail: `Detected in ${source}.`,
      hint: "Unset ANTHROPIC_API_KEY if you want subscription-based Claude login behavior.",
    });
  } else {
    const authAdvice = resolveClaudeAuthAdvice(env);
    if (authAdvice) {
      checks.push(authAdvice);
    } else if (!callerControlsHost) {
      // Hosted multi-tenant: "if Claude is logged in" refers to a host login
      // the user cannot perform. Unlike Codex, there IS a real subscription
      // route here, so name it rather than pushing them to an API key: the
      // token is minted on their own machine and pasted in, which is exactly
      // the thing they were looking for when they picked this adapter.
      checks.push({
        code: "claude_subscription_mode_possible",
        level: "info",
        message: "No Claude credentials are configured for this agent yet.",
        hint: "Add an Anthropic API key, or use your Claude Pro or Max plan by running `claude setup-token` on your own computer and pasting the token it prints.",
      });
    } else if (!targetIsRemote) {
      checks.push({
        code: "claude_subscription_mode_possible",
        level: "info",
        message: "ANTHROPIC_API_KEY is not set; subscription-based auth can be used if Claude is logged in.",
      });
    }
  }

  const canRunProbe =
    checks.every(
      (check) =>
        check.code !== "claude_cwd_invalid" &&
        check.code !== "claude_command_unresolvable" &&
        check.code !== "claude_managed_config_dir_failed",
    );
  let configuredModelIsCompatible = true;
  const configuredModel = asString(config.model, "").trim();
  const minimumCliVersion =
    claudeCommandLooksLike(command, "claude") &&
    (!hasBedrock || isBedrockModelId(configuredModel))
    ? minimumClaudeCliVersionForModel(configuredModel)
    : null;
  const versionProbeCommand = localProbe?.command ?? (targetIsRemote ? command : null);
  const versionProbeMatchesRuntime = targetIsRemote || localExecutablesMatch(
    localProbe?.command ?? null,
    localRuntimeCommand,
  );
  if (
    canRunProbe &&
    minimumCliVersion &&
    versionProbeCommand &&
    !versionProbeMatchesRuntime
  ) {
    configuredModelIsCompatible = false;
    checks.push({
      code: "claude_cli_version_probe_mismatch",
      level: "warn",
      message:
        "Skipped Fable 5.1 readiness probing because the runtime PATH selects a different Claude executable than the trusted local Test probe.",
      hint:
        "Ensure the runtime-selected Claude Code is 2.1.251 or newer. Execution will verify that exact executable before launch.",
    });
  } else if (canRunProbe && minimumCliVersion && versionProbeCommand) {
    const versionProbeEnv = localProbe?.env ?? env;
    const detectedCliVersion = await readClaudeCommandVersion({
      runId,
      command: versionProbeCommand,
      target,
      cwd,
      env: versionProbeEnv,
      timeoutSec: 45,
      graceSec: 5,
    });
    if (
      !detectedCliVersion ||
      !claudeCliVersionAtLeast(detectedCliVersion, minimumCliVersion)
    ) {
      configuredModelIsCompatible = false;
      checks.push({
        code: "claude_cli_version_incompatible",
        level: "error",
        message: `Claude Fable 5.1 requires Claude Code ${minimumCliVersion} or newer on the CLI lane.`,
        detail: detectedCliVersion
          ? `Detected Claude Code ${detectedCliVersion}.`
          : "Could not determine the installed Claude Code version.",
        hint: "Upgrade Claude Code or restore the default ACP lane, then retry the Test.",
      });
    }
  }

  if (canRunProbe && configuredModelIsCompatible) {
    if (!claudeCommandLooksLike(command, "claude")) {
      checks.push({
        code: "claude_hello_probe_skipped_custom_command",
        level: "info",
        message: "Skipped hello probe because command is not `claude`.",
        detail: command,
        hint: "Use the `claude` CLI command to run the automatic login and installation probe.",
      });
    } else if (localProbe && !localProbe.command) {
      // The trusted server PATH holds no `claude`, so the local probe cannot
      // run. Report a warn, never a silent pass.
      checks.push({
        code: "claude_hello_probe_skipped_unresolved_command",
        level: "warn",
        message: "Skipped the Claude hello probe because `claude` is not installed on the Paperclip host.",
        hint: "Install the `claude` CLI on the Paperclip host, then retry the Test.",
      });
    } else {
      const model = configuredModel;
      const effort = asString(config.effort, "").trim();
      const chrome = asBoolean(config.chrome, false);
      const maxTurns = asNumber(config.maxTurnsPerRun, 0);
      const dangerouslySkipPermissions = asBoolean(config.dangerouslySkipPermissions, true);
      const extraArgs = (() => {
        const fromExtraArgs = asStringArray(config.extraArgs);
        if (fromExtraArgs.length > 0) return fromExtraArgs;
        return asStringArray(config.args);
      })();

      // Sandbox bridges still add lease warmup and transport overhead, but
      // the standard-2 Cloudflare tier now probes fast enough that a 90s
      // budget leaves headroom without masking real hangs.
      const helloProbeTimeoutSec = Math.max(
        1,
        asNumber(config.helloProbeTimeoutSec, targetIsSandbox ? 90 : 45),
      );

      const probeChecks = await runClaudeCredentialHelloProbe({
        runId,
        target,
        command,
        cwd,
        env,
        model,
        effort,
        chrome,
        maxTurns,
        dangerouslySkipPermissions,
        extraArgs,
        hasBedrock,
        targetIsSandbox,
        targetIsRemote,
        helloProbeTimeoutSec,
      });
      checks.push(...probeChecks);
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
