import type { Db } from "@paperclipai/db";
import type { Environment, EnvironmentLease } from "@paperclipai/shared";
import { adapterSupportsRemoteManagedEnvironments } from "@paperclipai/shared";
import {
  adapterExecutionTargetToRemoteSpec,
  type AdapterExecutionTarget,
} from "@paperclipai/adapter-utils/execution-target";
import {
  clampSpanLabel,
  getActiveStepContext,
  normalizeProviderFamily,
  SANDBOX_STARTUP_OUTCOME,
  SANDBOX_STARTUP_SPAN_ATTRS,
} from "@paperclipai/adapter-utils/acpx-engine/startup-timing";
import { parseObject } from "../adapters/utils.js";
import { getStartupTracer } from "../instrumentation.js";
import { resolveEnvironmentDriverConfigForRuntime } from "./environment-config.js";
import type { EnvironmentRuntimeService } from "./environment-runtime.js";

export const DEFAULT_SANDBOX_REMOTE_CWD = "/tmp";

/** The minimal span surface the provider-exec seam calls. A real injected OTel
 * span satisfies it; the no-op tracer's span satisfies it too. */
type ExecSpan = {
  setAttribute(key: string, value: string | number | boolean): void;
  setStatus(status: { code: number; message?: string }): void;
  end(): void;
};

/**
 * The value of `SpanStatusCode.ERROR` in `@opentelemetry/api`. The server injects
 * a real OTel span, but this module stays OTel-free, so it uses the numeric value
 * directly. A failed exec span sets this status, so a trace UI counts and filters
 * the failure through the native span status, not only the `outcome` attribute.
 */
const SPAN_STATUS_CODE_ERROR = 2;

/** The minimal tracer surface the provider-exec seam calls. `getStartupTracer`
 * returns a real or no-op implementation that satisfies it. The optional third
 * argument is the explicit parent-context token: the seam passes the active
 * step context, so the exec span parents to its step span. */
type ExecTracer = {
  startSpan(name: string, options?: unknown, context?: unknown): ExecSpan;
};

/**
 * Set a numeric span attribute only when the value is a finite number. A value
 * that is absent, `NaN`, or `Infinity` yields no attribute — never a misleading
 * `0`. This mirrors the host counter guard below and the `adapter-utils`
 * startup-step guard.
 */
function setFiniteNumberAttr(span: ExecSpan, key: string, value: unknown): void {
  if (typeof value === "number" && Number.isFinite(value)) {
    span.setAttribute(key, value);
  }
}

/** Read a free-form metadata value as a finite number, or `undefined`. The
 * provider durations ride the exec result's untyped `metadata`, so a provider
 * that omits or mistypes one yields no attribute — never a misleading `0`. */
function toFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Read a free-form metadata value as a boolean, or `undefined`. The provider
 * cache-hit flag rides the exec result's untyped `metadata`, so a provider that
 * omits or mistypes it yields no attribute — never a misleading `false`. */
function toBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Compute the tail of `final` that the provider did NOT already stream.
 *
 * The provider streams output chunks in order. Those chunks form `delivered`.
 * The final result is `final`. In the normal path `final` continues
 * `delivered`, so the tail is `final` past the delivered length.
 *
 * A provider can stream a prefix and then fall back to a poll that returns a
 * different buffer. When `final` does not start with `delivered`, a length
 * slice would drop unrelated leading output or cut a chunk mid-text, so the
 * durable log would hold truncated or corrupt output. In that case this
 * function returns the whole `final` instead. That can repeat the streamed
 * prefix in the log, but the complete final output always reaches the log.
 * Repetition is safer than a silent loss of output.
 */
function undeliveredSuffix(delivered: string, final: string): string {
  if (!final) return "";
  if (delivered.length === 0) return final;
  if (final.startsWith(delivered)) return final.slice(delivered.length);
  return final;
}

/**
 * The closed input for one `sandbox.exec` span. The seam builds it from the
 * exec result and the active step context. Every field is already bounded or
 * numeric; the raw command clamps inside the helper below.
 */
interface SandboxExecSpanInput {
  /** The low-cardinality provider family (already through `normalizeProviderFamily`). */
  provider: string;
  /** The raw `argv[0]`. The helper clamps it; the raw value never rides the span. */
  command: string;
  /** The numeric process exit code, or `null`. */
  exitCode: number | null;
  /** The host-measured wall time of the execution. */
  wallMs: number;
  /** The provider handle-fetch wait before the execution ran. */
  waitBeforeMs: number | undefined;
  /** The in-sandbox run time of the execution. */
  sandboxMs: number | undefined;
  /** Whether the execution sits on the startup critical path. */
  criticalPath: boolean;
  /** Whether the provider served the sandbox handle from its warm cache. */
  cacheHit: boolean | undefined;
}

/**
 * Assemble every `sandbox.exec` span attribute in one place. This is the single
 * producer-side boundary for the exec span: it sets only the closed
 * `paperclip.sandbox.startup.exec.*` allowlist. The command rides only as a
 * clamped label, so a full command line, an argument, a path, an environment
 * value, or any standard-stream text can never ride the span. A non-finite
 * numeric input yields no attribute (fail open — never `NaN`, never a
 * misleading `0`).
 */
function setSandboxExecSpanAttributes(span: ExecSpan, input: SandboxExecSpanInput): void {
  const A = SANDBOX_STARTUP_SPAN_ATTRS;
  span.setAttribute(A.provider, input.provider);
  const command = clampSpanLabel("command", input.command);
  if (command !== undefined) span.setAttribute(A.execCommand, command);
  if (typeof input.exitCode === "number" && Number.isFinite(input.exitCode)) {
    span.setAttribute(A.execExitCode, input.exitCode);
  }
  setFiniteNumberAttr(span, A.execWallMs, input.wallMs);
  setFiniteNumberAttr(span, A.execWaitBeforeMs, input.waitBeforeMs);
  setFiniteNumberAttr(span, A.execSandboxMs, input.sandboxMs);
  // The transport time the host adds around the provider work: wall minus the
  // handle-fetch wait minus the in-sandbox run. Set it only when both parts are
  // present, so a provider that reports no durations yields no derived value.
  if (input.waitBeforeMs !== undefined && input.sandboxMs !== undefined) {
    setFiniteNumberAttr(span, A.execNetworkMs, input.wallMs - input.waitBeforeMs - input.sandboxMs);
  }
  span.setAttribute(A.execCriticalPath, input.criticalPath);
  // The explicit provider cache-hit flag, from `result.metadata.cacheHit`. The
  // plugin decides it at the handle lookup, so the span no longer infers a
  // cache hit from `wait_before_ms == 0`. A provider that omits it yields no
  // attribute.
  if (typeof input.cacheHit === "boolean") {
    span.setAttribute(A.execCacheHit, input.cacheHit);
  }
  const failed = input.exitCode !== 0;
  span.setAttribute(
    A.outcome,
    failed ? SANDBOX_STARTUP_OUTCOME.failed : SANDBOX_STARTUP_OUTCOME.ok,
  );
  // A non-zero exit code is a failed execution, so set the native span status to
  // ERROR too. The success path leaves the status unset, so a successful exec
  // keeps the default OTel status. A `null` exit code counts as failed here.
  if (failed) span.setStatus({ code: SPAN_STATUS_CODE_ERROR });
}

/**
 * Record a failed `sandbox.exec` span when the provider execution throws. There
 * is no exec result, so only the bounded provider family, the clamped command
 * label, the measured wall time, the critical-path flag, and the `failed`
 * outcome ride the span. The raw command never rides the span. A thrown
 * execution now still produces a span, instead of no span at all.
 */
function setSandboxExecSpanFailure(
  span: ExecSpan,
  input: { provider: string; command: string; wallMs: number; criticalPath: boolean },
): void {
  const A = SANDBOX_STARTUP_SPAN_ATTRS;
  span.setAttribute(A.provider, input.provider);
  const command = clampSpanLabel("command", input.command);
  if (command !== undefined) span.setAttribute(A.execCommand, command);
  setFiniteNumberAttr(span, A.execWallMs, input.wallMs);
  span.setAttribute(A.execCriticalPath, input.criticalPath);
  span.setAttribute(A.outcome, SANDBOX_STARTUP_OUTCOME.failed);
  // A thrown execution is a failed execution, so set the native span status to
  // ERROR too, not only the `outcome` attribute.
  span.setStatus({ code: SPAN_STATUS_CODE_ERROR });
}

export async function resolveEnvironmentExecutionTarget(input: {
  db: Db;
  companyId: string;
  adapterType: string;
  environment: {
    id?: string;
    driver: string;
    config: Record<string, unknown> | null;
  };
  leaseId?: string | null;
  leaseMetadata: Record<string, unknown> | null;
  lease?: EnvironmentLease | null;
  environmentRuntime?: EnvironmentRuntimeService | null;
  // The startup tracer for the provider-exec span. Defaults to the endpoint-
  // gated server tracer, which is a no-op when tracing is off. Tests inject a
  // recording tracer.
  tracer?: ExecTracer;
}): Promise<AdapterExecutionTarget | null> {
  if (input.environment.driver === "local") {
    return {
      kind: "local",
      environmentId: input.environment.id ?? null,
      leaseId: input.leaseId ?? null,
    };
  }

  if (input.environment.driver === "sandbox") {
    // Keep this gate in lockstep with the shared capability metadata that the
    // environment selector and capabilities API expose; a drift here lets the
    // UI offer environments the runtime then refuses.
    if (!adapterSupportsRemoteManagedEnvironments(input.adapterType)) {
      return null;
    }

    const parsed = await resolveEnvironmentDriverConfigForRuntime(input.db, input.companyId, {
      id: input.environment.id,
      driver: input.environment.driver as "sandbox",
      config: parseObject(input.environment.config),
    });
    if (parsed.driver !== "sandbox") {
      return null;
    }

    const remoteCwd =
      typeof input.leaseMetadata?.remoteCwd === "string" && input.leaseMetadata.remoteCwd.trim().length > 0
        ? input.leaseMetadata.remoteCwd.trim()
        : DEFAULT_SANDBOX_REMOTE_CWD;
    const timeoutMs = "timeoutMs" in parsed.config ? parsed.config.timeoutMs : null;
    const shellCommand =
      input.leaseMetadata?.shellCommand === "bash" || input.leaseMetadata?.shellCommand === "sh"
        ? input.leaseMetadata.shellCommand
        : null;

    // Disable the in-sandbox network-install shim ONLY for providers that
    // explicitly declare their runtime images are pre-baked / contractually
    // complete (adapter CLI already on PATH, run behind a locked egress) — the
    // per-lease `runtimeImagePrebaked` capability signal. We must NOT key off the
    // generic "plugin-backed" marker (`sandboxProviderPlugin`): a provider plugin
    // that ships a GENERIC sandbox and legitimately relies on runtime
    // installation would otherwise be wrongly marked pre-baked, dropping its
    // install (Layer 3) and turning a provisionable run into a spurious
    // `adapter_runtime_image_mismatch`. Such a plugin omits the flag and keeps
    // the install path; built-in sandbox providers (e.g. e2b) never set it.
    const prebakedRuntime = input.leaseMetadata?.runtimeImagePrebaked === true;

    // Per-lease-runner cumulative counters for startup-step attribution (Open
    // Q1). Closed over by the `runner.execute` seam below and read back as
    // deltas by `measureStartupStep`.
    let execCount = 0;
    let providerExecMs = 0;
    let providerGetMs = 0;
    const accumulateProviderDurations = (metadata: Record<string, unknown> | undefined): void => {
      if (!metadata) return;
      const exec = metadata.durationMs;
      const get = metadata.getDurationMs;
      if (typeof exec === "number" && Number.isFinite(exec)) providerExecMs += exec;
      if (typeof get === "number" && Number.isFinite(get)) providerGetMs += get;
    };

    return {
      kind: "remote",
      transport: "sandbox",
      providerKey: parsed.config.provider,
      shellCommand,
      remoteCwd,
      ...(effectiveCapabilities ? { effectiveCapabilities: Object.freeze({ ...effectiveCapabilities }) } : {}),
      environmentId: input.environment.id ?? null,
      leaseId: input.leaseId ?? null,
      timeoutMs,
      prebakedRuntime,
      // Run-log streaming defaults ON for sandbox environments so agent CLI
      // output reaches the UI mid-run; `streamRunLogs: false` is an explicit
      // opt-out back to batch-at-end delivery.
      streamRunLogs: parsed.config.streamRunLogs !== false,
      // Interactive ACP output streaming is decided downstream from the effective
      // capability snapshot alone: the process session bridge streams only when
      // the provider keeps persistent process sessions and runs independent
      // control commands. The snapshot is absent when resolution failed, so the
      // bridge fails closed to the output-file poll.
      runner: input.environmentRuntime && input.lease
        ? {
            // Provider-backed sandbox RPCs do not surface bounded mid-stream
            // progress for a single stdin upload, so keep the capability disabled
            // here. The client falls back to the chunked upload path when this is
            // false.
            supportsSingleStreamStdinProgress: false,
            // Carry the verified concurrent-sync opt-in to the sync client. The
            // client copies it onto the native path and ignores it on the base64
            // fallback, which always permits concurrency. A null snapshot or a
            // provider that never opted in keeps it false, so an unverified
            // provider never permits concurrent sync operations.
            allowConcurrentSyncOperations: effectiveCapabilities?.concurrentSyncOperations === true,
            execute: async (commandInput) => {
              execCount += 1;
              const startedAt = new Date().toISOString();
              const result = await input.environmentRuntime!.execute({
                environment: input.environment as Environment,
                lease: input.lease!,
                command: commandInput.command,
                args: commandInput.args,
                cwd: commandInput.cwd ?? remoteCwd,
                env: commandInput.env,
                stdin: commandInput.stdin,
                timeoutMs: commandInput.timeoutMs,
                // Forward the live-output sink so a driver that streams can
                // deliver chunks as they arrive. When the driver honors it, it
                // sets `result.streamed` and we skip the buffered dump below to
                // avoid logging the same output twice.
                onOutput: commandInput.onOutput,
                // Forward the run id so the plugin-backed sandbox driver can
                // bridge worker output chunks back to onOutput over the worker
                // RPC boundary (channel env-exec-output:${runId}).
                runId: commandInput.runId,
              });
              accumulateProviderDurations(result.metadata);
              // Only emit the buffered stdout/stderr when the driver did NOT
              // already stream it live via onOutput. Legacy (non-streaming)
              // drivers leave `streamed` unset, preserving the original dump.
              if (!result.streamed) {
                if (result.stdout) await commandInput.onLog?.("stdout", result.stdout);
                if (result.stderr) await commandInput.onLog?.("stderr", result.stderr);
              }
              return {
                exitCode: result.exitCode,
                signal: result.signal ?? null,
                timedOut: result.timedOut,
                stdout: result.stdout,
                stderr: result.stderr,
                pid: null,
                startedAt,
                streamed: result.streamed,
              };
            },
            // Expose the native file-sync capability only when the provider's
            // worker advertises BOTH sync verbs AND the effective snapshot still
            // grants native sync; otherwise leave syncIn/syncOut undefined so
            // the orchestrator keeps the byte-identical base64 path.
            ...(nativeSyncAllowed &&
            input.environmentRuntime.supportsSync({
              environment: input.environment as Environment,
              lease: input.lease,
            })
              ? {
                  syncIn: (operations) =>
                    input.environmentRuntime!.syncIn({
                      environment: input.environment as Environment,
                      lease: input.lease!,
                      operations,
                    }),
                  syncOut: (operations) =>
                    input.environmentRuntime!.syncOut({
                      environment: input.environment as Environment,
                      lease: input.lease!,
                      operations,
                    }),
                }
              : {}),
            // Expose the duplex channel only when the effective snapshot grants
            // the opt-in `duplexCommandStream` capability. A null snapshot
            // (resolution failed or the snapshot is not resolvable) leaves the
            // member undefined, so the caller keeps the file bridge. This mirrors
            // the syncIn/syncOut gate above and fails closed.
            ...(effectiveCapabilities?.duplexCommandStream
              ? {
                  openDuplexChannel: (channelInput) =>
                    input.environmentRuntime!.openDuplexChannel({
                      environment: input.environment as Environment,
                      lease: input.lease!,
                      command: channelInput.command,
                    }),
                }
              : {}),
          }
        : undefined,
    };
  }

  if (
    !adapterSupportsRemoteManagedEnvironments(input.adapterType) ||
    input.environment.driver !== "ssh"
  ) {
    return null;
  }

  const parsed = await resolveEnvironmentDriverConfigForRuntime(input.db, input.companyId, {
    id: input.environment.id,
    driver: input.environment.driver as "ssh",
    config: parseObject(input.environment.config),
  });
  if (parsed.driver !== "ssh") {
    return null;
  }

  const remoteCwd =
    typeof input.leaseMetadata?.remoteCwd === "string" && input.leaseMetadata.remoteCwd.trim().length > 0
      ? input.leaseMetadata.remoteCwd.trim()
      : parsed.config.remoteWorkspacePath;

  return {
    kind: "remote",
    transport: "ssh",
    environmentId: input.environment.id ?? null,
    leaseId: input.leaseId ?? null,
    remoteCwd,
    spec: {
      host: parsed.config.host,
      port: parsed.config.port,
      username: parsed.config.username,
      remoteWorkspacePath: parsed.config.remoteWorkspacePath,
      privateKey: parsed.config.privateKey,
      knownHosts: parsed.config.knownHosts,
      strictHostKeyChecking: parsed.config.strictHostKeyChecking,
      remoteCwd,
    },
  };
}

export async function resolveEnvironmentExecutionTransport(
  input: Parameters<typeof resolveEnvironmentExecutionTarget>[0],
): Promise<Record<string, unknown> | null> {
  return adapterExecutionTargetToRemoteSpec(await resolveEnvironmentExecutionTarget(input)) as Record<string, unknown> | null;
}
