import { randomUUID } from "node:crypto";
import { definePlugin } from "@paperclipai/plugin-sdk";
import type {
  PluginEnvironmentAcquireLeaseParams,
  PluginEnvironmentDestroyLeaseParams,
  PluginEnvironmentExecuteParams,
  PluginEnvironmentExecuteResult,
  PluginEnvironmentLease,
  PluginEnvironmentProbeParams,
  PluginEnvironmentProbeResult,
  PluginEnvironmentRealizeWorkspaceParams,
  PluginEnvironmentRealizeWorkspaceResult,
  PluginEnvironmentReleaseLeaseParams,
  PluginEnvironmentResumeLeaseParams,
  PluginEnvironmentValidateConfigParams,
  PluginEnvironmentValidationResult,
} from "@paperclipai/plugin-sdk";

// ---------------------------------------------------------------------------
// Driver config
// ---------------------------------------------------------------------------

interface MitosDriverConfig {
  apiUrl: string | null;
  token: string | null;
  template: string | null;
  cpu: number | null;
  memory: number | null;
  execTimeoutMs: number;
  requestTimeoutMs: number;
  reuseLease: boolean;
}

const DEFAULT_EXEC_TIMEOUT_MS = 300_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_REMOTE_CWD = "/workspace";

function parseOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseOptionalNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parsePositiveIntMs(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function parseDriverConfig(raw: Record<string, unknown>): MitosDriverConfig {
  return {
    apiUrl: parseOptionalString(raw.apiUrl),
    // `snapshot` is accepted as an alias for `template` so config authored
    // against the snapshot-fork vocabulary still resolves a fork base.
    template: parseOptionalString(raw.template) ?? parseOptionalString(raw.snapshot),
    token: parseOptionalString(raw.token) ?? parseOptionalString(raw.apiKey),
    cpu: parseOptionalNumber(raw.cpu),
    memory: parseOptionalNumber(raw.memory),
    execTimeoutMs: parsePositiveIntMs(raw.execTimeoutMs, DEFAULT_EXEC_TIMEOUT_MS),
    requestTimeoutMs: parsePositiveIntMs(raw.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS),
    reuseLease: raw.reuseLease === true,
  };
}

function resolveToken(config: MitosDriverConfig): string | null {
  if (config.token) return config.token;
  const envToken = process.env.MITOS_SANDBOX_TOKEN?.trim();
  return envToken ? envToken : null;
}

function isValidUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// sandbox-server REST client
//
// A small direct fetch client. We intentionally avoid a cross-repo dependency
// on the sandbox TypeScript SDK so this provider installs as a standalone
// package with no extra deps.
//
// Secret handling: the bearer token is only ever sent in the Authorization
// header. It is never returned in errors, never logged, and never written to
// lease metadata.
// ---------------------------------------------------------------------------

interface ForkResponse {
  id: string;
  template_id: string;
  endpoint: string;
  fork_time_ms?: number;
  // forkd-backed deployments mint a per-sandbox token on fork. The standalone
  // sandbox-server is tokenless and omits this. We honor it when present.
  token?: string;
}

interface ExecResponse {
  exit_code: number;
  stdout: string;
  stderr: string;
  exec_time_ms?: number;
}

interface MitosClientOptions {
  /** Control-plane base URL (fork, terminate, health, templates). */
  apiUrl: string;
  /** Bearer token sent on exec/files requests, when the server is token-gated. */
  token: string | null;
  requestTimeoutMs: number;
}

class MitosError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.name = "MitosError";
    this.status = status;
  }
}

async function requestJson<T>(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  token: string | null,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  try {
    const response = await fetch(url, { ...init, headers, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) {
      let detail = text;
      try {
        const parsed = JSON.parse(text) as { error?: string };
        if (parsed.error) detail = parsed.error;
      } catch {
        // non-JSON error body; surface the raw text (never includes the token).
      }
      throw new MitosError(
        `sandbox-server ${init.method ?? "GET"} ${new URL(url).pathname} failed: ${response.status} ${detail}`.trim(),
        response.status,
      );
    }
    if (text.length === 0) {
      return undefined as T;
    }
    return JSON.parse(text) as T;
  } catch (error) {
    if (error instanceof MitosError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new MitosError(`sandbox-server request timed out after ${timeoutMs}ms`, null);
    }
    throw new MitosError(`sandbox-server request failed: ${formatErrorMessage(error)}`, null);
  } finally {
    clearTimeout(timer);
  }
}

class MitosClient {
  private readonly apiUrl: string;
  private readonly token: string | null;
  private readonly requestTimeoutMs: number;

  constructor(options: MitosClientOptions) {
    this.apiUrl = trimTrailingSlash(options.apiUrl);
    this.token = options.token;
    this.requestTimeoutMs = options.requestTimeoutMs;
  }

  async health(): Promise<Record<string, unknown>> {
    return requestJson<Record<string, unknown>>(
      `${this.apiUrl}/v1/health`,
      { method: "GET" },
      this.requestTimeoutMs,
      // Health is unauthenticated on the standalone server; omit the token.
      null,
    );
  }

  async listTemplates(): Promise<Array<{ id: string }>> {
    return requestJson<Array<{ id: string }>>(
      `${this.apiUrl}/v1/templates`,
      { method: "GET" },
      this.requestTimeoutMs,
      null,
    );
  }

  async fork(template: string, id: string): Promise<ForkResponse> {
    return requestJson<ForkResponse>(
      `${this.apiUrl}/v1/fork`,
      { method: "POST", body: JSON.stringify({ template, id }) },
      this.requestTimeoutMs,
      null,
    );
  }

  async listSandboxes(): Promise<Array<{ id: string }>> {
    return requestJson<Array<{ id: string }>>(
      `${this.apiUrl}/v1/sandboxes`,
      { method: "GET" },
      this.requestTimeoutMs,
      null,
    );
  }

  async terminate(id: string): Promise<void> {
    await requestJson<unknown>(
      `${this.apiUrl}/v1/sandboxes/${encodeURIComponent(id)}`,
      { method: "DELETE" },
      this.requestTimeoutMs,
      null,
    );
  }

  /**
   * Per-sandbox endpoint client for exec/files. `endpoint` is the origin the
   * fork response handed back; on the standalone server it equals apiUrl, but a
   * forkd deployment may route each sandbox to its owning node.
   */
  private sandboxBase(endpoint: string | null): string {
    return trimTrailingSlash(endpoint && endpoint.length > 0 ? endpoint : this.apiUrl);
  }

  async exec(input: {
    endpoint: string | null;
    sandbox: string;
    token: string | null;
    command: string;
    workingDir?: string;
    env?: Record<string, string>;
    timeoutSeconds: number;
  }): Promise<ExecResponse> {
    return requestJson<ExecResponse>(
      `${this.sandboxBase(input.endpoint)}/v1/exec`,
      {
        method: "POST",
        body: JSON.stringify({
          sandbox: input.sandbox,
          command: input.command,
          working_dir: input.workingDir,
          env: input.env,
          timeout: input.timeoutSeconds,
        }),
      },
      // Exec timeout is bounded by the command timeout plus headroom.
      input.timeoutSeconds * 1000 + this.requestTimeoutMs,
      input.token ?? this.token,
    );
  }

  async writeFile(input: {
    endpoint: string | null;
    sandbox: string;
    token: string | null;
    path: string;
    content: string;
    mode?: number;
  }): Promise<void> {
    await requestJson<unknown>(
      `${this.sandboxBase(input.endpoint)}/v1/files/write`,
      {
        method: "POST",
        body: JSON.stringify({
          sandbox: input.sandbox,
          path: input.path,
          content: input.content,
          mode: input.mode,
        }),
      },
      this.requestTimeoutMs,
      input.token ?? this.token,
    );
  }

  async mkdir(input: {
    endpoint: string | null;
    sandbox: string;
    token: string | null;
    path: string;
  }): Promise<void> {
    await requestJson<unknown>(
      `${this.sandboxBase(input.endpoint)}/v1/files/mkdir`,
      {
        method: "POST",
        body: JSON.stringify({ sandbox: input.sandbox, path: input.path }),
      },
      this.requestTimeoutMs,
      input.token ?? this.token,
    );
  }
}

// ---------------------------------------------------------------------------
// Lease state
// ---------------------------------------------------------------------------

interface LeaseState {
  endpoint: string | null;
  // The per-sandbox bearer token from the fork response, when the server mints
  // one. Stored in lease metadata so exec/realize can present it without a
  // re-fork. The standalone server is tokenless, so this is usually null.
  token: string | null;
  remoteCwd: string;
}

function readLeaseState(metadata: Record<string, unknown> | undefined): LeaseState {
  const endpoint = typeof metadata?.endpoint === "string" ? metadata.endpoint : null;
  const token = typeof metadata?.token === "string" ? metadata.token : null;
  const remoteCwd =
    typeof metadata?.remoteCwd === "string" && metadata.remoteCwd.trim().length > 0
      ? metadata.remoteCwd.trim()
      : DEFAULT_REMOTE_CWD;
  return { endpoint, token, remoteCwd };
}

function leaseMetadata(input: {
  config: MitosDriverConfig;
  sandboxId: string;
  fork: ForkResponse;
  remoteCwd: string;
  resumedLease: boolean;
}): Record<string, unknown> {
  return {
    provider: "mitos",
    sandboxId: input.sandboxId,
    template: input.config.template,
    endpoint: input.fork.endpoint ?? null,
    // The per-sandbox token belongs in lease metadata, not in logs. It is a
    // capability scoped to a single ephemeral sandbox, mirroring how the
    // daytona provider keeps sandbox handles in metadata.
    token: typeof input.fork.token === "string" ? input.fork.token : null,
    remoteCwd: input.remoteCwd,
    cpu: input.config.cpu,
    memory: input.config.memory,
    reuseLease: input.config.reuseLease,
    resumedLease: input.resumedLease,
    forkTimeMs: typeof input.fork.fork_time_ms === "number" ? input.fork.fork_time_ms : null,
  };
}

function toTimeoutSeconds(timeoutMs: number): number {
  return Math.max(1, Math.ceil(timeoutMs / 1000));
}

function resolveExecTimeoutMs(paramsTimeoutMs: number | undefined, config: MitosDriverConfig): number {
  return paramsTimeoutMs != null && Number.isFinite(paramsTimeoutMs) && paramsTimeoutMs > 0
    ? Math.trunc(paramsTimeoutMs)
    : config.execTimeoutMs;
}

function createClient(config: MitosDriverConfig): MitosClient {
  if (!config.apiUrl) {
    throw new Error("Mitos sandbox environments require apiUrl (the sandbox-server base URL).");
  }
  return new MitosClient({
    apiUrl: config.apiUrl,
    token: resolveToken(config),
    requestTimeoutMs: config.requestTimeoutMs,
  });
}

// Each forked sandbox needs a caller-supplied id. We mint a stable, collision-
// resistant id per acquire so concurrent runs never clobber one another.
function mintSandboxId(): string {
  return `mitos-${randomUUID()}`;
}

function defaultRemoteCwd(params: { requestedCwd?: string }): string {
  const requested = typeof params.requestedCwd === "string" ? params.requestedCwd.trim() : "";
  if (requested.length > 0) {
    return requested;
  }
  return DEFAULT_REMOTE_CWD;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("Mitos snapshot-fork sandbox provider plugin ready");
  },

  async onHealth() {
    return { status: "ok", message: "Mitos sandbox provider plugin healthy" };
  },

  async onEnvironmentValidateConfig(
    params: PluginEnvironmentValidateConfigParams,
  ): Promise<PluginEnvironmentValidationResult> {
    const config = parseDriverConfig(params.config);
    const errors: string[] = [];

    if (!config.apiUrl) {
      errors.push("apiUrl is required (the sandbox-server base URL).");
    } else if (!isValidUrl(config.apiUrl)) {
      errors.push("apiUrl must be a valid URL.");
    }
    if (!config.template) {
      errors.push("template is required (the template or snapshot id to fork from).");
    }
    if (config.execTimeoutMs < 1 || config.execTimeoutMs > 86_400_000) {
      errors.push("execTimeoutMs must be between 1 and 86400000.");
    }
    if (config.requestTimeoutMs < 1 || config.requestTimeoutMs > 86_400_000) {
      errors.push("requestTimeoutMs must be between 1 and 86400000.");
    }
    for (const [key, value] of Object.entries({ cpu: config.cpu, memory: config.memory })) {
      if (value != null && value <= 0) {
        errors.push(`${key} must be greater than 0 when provided.`);
      }
    }

    if (errors.length > 0) {
      return { ok: false, errors };
    }

    // Reachability and template existence: GET /v1/health then confirm the
    // configured template is registered on the server.
    const warnings: string[] = [];
    try {
      const client = createClient(config);
      await client.health();
      const templates = await client.listTemplates();
      const known = new Set(templates.map((t) => t.id));
      if (config.template && !known.has(config.template)) {
        errors.push(
          `template "${config.template}" is not registered on the sandbox-server. Create it first with POST /v1/templates, then retry.`,
        );
      }
    } catch (error) {
      // A control-plane that is unreachable at config time is a warning, not a
      // hard failure: the server may come up before the first run. The error
      // text never carries the token.
      warnings.push(
        `Could not verify the sandbox-server at config time: ${formatErrorMessage(error)}`,
      );
    }

    if (errors.length > 0) {
      return { ok: false, errors, ...(warnings.length > 0 ? { warnings } : {}) };
    }

    return {
      ok: true,
      ...(warnings.length > 0 ? { warnings } : {}),
      normalizedConfig: { ...config, token: undefined },
    };
  },

  async onEnvironmentProbe(
    params: PluginEnvironmentProbeParams,
  ): Promise<PluginEnvironmentProbeResult> {
    const config = parseDriverConfig(params.config);
    try {
      const client = createClient(config);
      const health = await client.health();
      const templates = await client.listTemplates();
      const known = new Set(templates.map((t) => t.id));
      const templateReady = config.template != null && known.has(config.template);
      return {
        ok: templateReady,
        summary: templateReady
          ? `Connected to sandbox-server; template "${config.template}" is ready to fork.`
          : `Connected to sandbox-server, but template "${config.template}" is not registered.`,
        metadata: {
          provider: "mitos",
          template: config.template,
          templateReady,
          serverStatus: typeof health.status === "string" ? health.status : null,
          mock: health.mock === true,
          templateCount: templates.length,
          reuseLease: config.reuseLease,
        },
      };
    } catch (error) {
      return {
        ok: false,
        summary: "Mitos sandbox-server probe failed.",
        metadata: {
          provider: "mitos",
          template: config.template,
          reuseLease: config.reuseLease,
          error: formatErrorMessage(error),
        },
      };
    }
  },

  async onEnvironmentAcquireLease(
    params: PluginEnvironmentAcquireLeaseParams,
  ): Promise<PluginEnvironmentLease> {
    const config = parseDriverConfig(params.config);
    if (!config.template) {
      throw new Error("Mitos sandbox environments require a template to fork from.");
    }
    const client = createClient(config);
    const sandboxId = mintSandboxId();
    // The memory-fork fast path: a single POST /v1/fork from the warm template.
    const fork = await client.fork(config.template, sandboxId);
    const remoteCwd = defaultRemoteCwd(params);
    try {
      // Ensure the workspace root exists in the freshly forked sandbox.
      await client.mkdir({
        endpoint: fork.endpoint ?? null,
        sandbox: sandboxId,
        token: typeof fork.token === "string" ? fork.token : null,
        path: remoteCwd,
      });
      return {
        providerLeaseId: sandboxId,
        metadata: leaseMetadata({ config, sandboxId, fork, remoteCwd, resumedLease: false }),
      };
    } catch (error) {
      await client.terminate(sandboxId).catch(() => undefined);
      throw error;
    }
  },

  async onEnvironmentResumeLease(
    params: PluginEnvironmentResumeLeaseParams,
  ): Promise<PluginEnvironmentLease> {
    const config = parseDriverConfig(params.config);
    if (!config.template) {
      throw new Error("Mitos sandbox environments require a template to fork from.");
    }
    const client = createClient(config);

    // reuseLease keeps the sandbox alive across runs; resume reuses it in place
    // when it is still registered on the server.
    if (config.reuseLease && params.providerLeaseId) {
      const sandboxes = await client
        .listSandboxes()
        .then((list) => new Set(list.map((s) => s.id)))
        .catch(() => null);
      if (sandboxes && sandboxes.has(params.providerLeaseId)) {
        const prior = readLeaseState(params.leaseMetadata);
        return {
          providerLeaseId: params.providerLeaseId,
          metadata: leaseMetadata({
            config,
            sandboxId: params.providerLeaseId,
            fork: {
              id: params.providerLeaseId,
              template_id: config.template,
              endpoint: prior.endpoint ?? "",
              token: prior.token ?? undefined,
            },
            remoteCwd: prior.remoteCwd,
            resumedLease: true,
          }),
        };
      }
    }

    // Fast resume by re-forking from the snapshot. The memory-fork is itself the
    // fast path, so a fresh fork is the resume primitive when the prior sandbox
    // is gone or reuseLease is off. True in-place memory-resume (suspend then
    // restore the same VM) is a sandbox-server follow-up; see README.
    const sandboxId = mintSandboxId();
    const fork = await client.fork(config.template, sandboxId);
    const prior = readLeaseState(params.leaseMetadata);
    const remoteCwd = prior.remoteCwd;
    try {
      await client.mkdir({
        endpoint: fork.endpoint ?? null,
        sandbox: sandboxId,
        token: typeof fork.token === "string" ? fork.token : null,
        path: remoteCwd,
      });
      return {
        providerLeaseId: sandboxId,
        metadata: leaseMetadata({ config, sandboxId, fork, remoteCwd, resumedLease: true }),
      };
    } catch (error) {
      await client.terminate(sandboxId).catch(() => undefined);
      throw error;
    }
  },

  async onEnvironmentReleaseLease(
    params: PluginEnvironmentReleaseLeaseParams,
  ): Promise<void> {
    if (!params.providerLeaseId) return;
    const config = parseDriverConfig(params.config);
    // reuseLease keeps the sandbox alive for a later in-place resume. The
    // sandbox-server has no idle/pause endpoint yet, so "keep" is simply "do
    // not delete" for v1; a true pause endpoint is a sandbox-server follow-up.
    if (config.reuseLease) {
      return;
    }
    const client = createClient(config);
    await client.terminate(params.providerLeaseId).catch(() => undefined);
  },

  async onEnvironmentDestroyLease(
    params: PluginEnvironmentDestroyLeaseParams,
  ): Promise<void> {
    if (!params.providerLeaseId) return;
    const config = parseDriverConfig(params.config);
    const client = createClient(config);
    await client.terminate(params.providerLeaseId);
  },

  async onEnvironmentRealizeWorkspace(
    params: PluginEnvironmentRealizeWorkspaceParams,
  ): Promise<PluginEnvironmentRealizeWorkspaceResult> {
    const config = parseDriverConfig(params.config);
    const state = readLeaseState(params.lease.metadata);
    const remoteCwd =
      state.remoteCwd ||
      params.workspace.remotePath ||
      params.workspace.localPath ||
      DEFAULT_REMOTE_CWD;

    if (params.lease.providerLeaseId) {
      const client = createClient(config);
      // Seed the workspace root. The host drives install commands through
      // onEnvironmentExecute; realizeWorkspace only guarantees the cwd exists.
      await client.mkdir({
        endpoint: state.endpoint,
        sandbox: params.lease.providerLeaseId,
        token: state.token,
        path: remoteCwd,
      });
    }

    return {
      cwd: remoteCwd,
      metadata: { provider: "mitos", remoteCwd },
    };
  },

  async onEnvironmentExecute(
    params: PluginEnvironmentExecuteParams,
  ): Promise<PluginEnvironmentExecuteResult> {
    if (!params.lease.providerLeaseId) {
      return {
        exitCode: 1,
        timedOut: false,
        stdout: "",
        stderr: "No provider lease ID available for execution.",
      };
    }

    const config = parseDriverConfig(params.config);
    const state = readLeaseState(params.lease.metadata);
    const client = createClient(config);

    const timeoutMs = resolveExecTimeoutMs(params.timeoutMs, config);
    const timeoutSeconds = toTimeoutSeconds(timeoutMs);

    // The sandbox-server exec endpoint runs a single command string. Compose
    // args into one shell-safe command line, matching how the daytona and e2b
    // providers shape a one-shot exec.
    const commandLine = buildCommandLine(params);

    try {
      const result = await client.exec({
        endpoint: state.endpoint,
        sandbox: params.lease.providerLeaseId,
        token: state.token,
        command: commandLine,
        workingDir: params.cwd,
        env: params.env,
        timeoutSeconds,
      });
      return {
        exitCode: typeof result.exit_code === "number" ? result.exit_code : 1,
        timedOut: false,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      };
    } catch (error) {
      if (error instanceof MitosError && error.status === null) {
        // A null-status MitosError is a transport-level failure (timeout or
        // network). Surface it as a timed-out result so the host can retry.
        return {
          exitCode: null,
          timedOut: true,
          stdout: "",
          stderr: `${formatErrorMessage(error)}\n`,
        };
      }
      throw error;
    }
  },
});

// ---------------------------------------------------------------------------
// Helpers that need the client/params but not the plugin object
// ---------------------------------------------------------------------------

function isValidShellEnvKey(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

// Compose command + args into a single shell line. stdin redirection is staged
// via a heredoc so the one-shot exec endpoint (which has no stdin channel) can
// still feed input to the command.
function buildCommandLine(params: PluginEnvironmentExecuteParams): string {
  for (const key of Object.keys(params.env ?? {})) {
    if (!isValidShellEnvKey(key)) {
      throw new Error(`Invalid sandbox environment variable key: ${key}`);
    }
  }
  const parts = [shellQuote(params.command), ...(params.args ?? []).map(shellQuote)];
  let line = parts.join(" ");
  if (params.stdin != null) {
    const delimiter = `MITOS_STDIN_${randomUUID().replace(/-/g, "")}`;
    // Quote the delimiter so the heredoc body is passed through literally.
    line = `${line} <<'${delimiter}'\n${params.stdin}\n${delimiter}`;
  }
  return line;
}

export default plugin;
export { MitosClient, MitosError, parseDriverConfig, buildCommandLine };
