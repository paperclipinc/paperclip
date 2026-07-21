import type { AdapterRegistryEntry } from "./adapter-registry.js";

export interface AdapterDefaults {
  runtimeImage: string;
  envKeys: string[];
  allowFqdns: string[];
  probeCommand: string[];
  /** Non-secret env injected as the base layer for the Job (process-env wins on top). */
  defaultEnv?: Record<string, string>;
}

// Each adapter's `envKeys` are the host env vars materialized into the sandbox
// Job. They include the provider API key AND the provider base URL (e.g.
// ANTHROPIC_BASE_URL / OPENAI_BASE_URL): the CLIs honor a custom OpenAI-compatible
// endpoint via that env var, so without it in the allowlist the base URL is
// stripped and the agent always hits the default public endpoint. Allowing the
// base-url keys lets operators route a sandbox through a self-hosted /
// OpenAI-compatible gateway (vLLM, LiteLLM, Bifrost, etc.) by setting the
// corresponding env in the agent's adapterConfig.env.
const REGISTRY: Record<string, AdapterDefaults> = {
  claude_local: {
    runtimeImage: "ghcr.io/paperclipai/agent-runtime-claude:v1",
    envKeys: ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"],
    allowFqdns: ["api.anthropic.com"],
    probeCommand: ["claude", "--version"],
  },
  codex_local: {
    runtimeImage: "ghcr.io/paperclipai/agent-runtime-codex:v1",
    envKeys: ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_API_BASE"],
    allowFqdns: ["api.openai.com"],
    probeCommand: ["codex", "--version"],
  },
  gemini_local: {
    runtimeImage: "ghcr.io/paperclipai/agent-runtime-gemini:v1",
    envKeys: ["GOOGLE_API_KEY", "GEMINI_API_KEY", "GOOGLE_GEMINI_BASE_URL"],
    allowFqdns: ["generativelanguage.googleapis.com"],
    probeCommand: ["gemini", "--version"],
  },
  cursor_local: {
    runtimeImage: "ghcr.io/paperclipai/agent-runtime-cursor:v1",
    envKeys: ["CURSOR_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_API_BASE"],
    allowFqdns: ["api.anthropic.com", "api.openai.com"],
    probeCommand: ["cursor-agent", "--version"],
  },
  opencode_local: {
    runtimeImage: "ghcr.io/paperclipai/agent-runtime-opencode:v1",
    envKeys: ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_API_BASE", "OPENROUTER_API_KEY", "OPENROUTER_BASE_URL"],
    allowFqdns: ["api.anthropic.com", "api.openai.com", "openrouter.ai"],
    probeCommand: ["opencode", "--version"],
  },
  pi_local: {
    runtimeImage: "ghcr.io/paperclipai/agent-runtime-pi:v1",
    envKeys: ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"],
    allowFqdns: ["api.anthropic.com"],
    probeCommand: ["pi", "--version"],
  },
};

// The cursor adapter package's `type` is "cursor" while this registry (and
// environment configs in the wild) use "cursor_local". Normalize so a per-run
// adapter hint carrying the package's own type string resolves.
const ADAPTER_TYPE_ALIASES: Record<string, string> = { cursor: "cursor_local" };

function normalizeAdapterType(adapterType: string): string {
  return ADAPTER_TYPE_ALIASES[adapterType] ?? adapterType;
}

export const KNOWN_ADAPTER_TYPES: ReadonlySet<string> = new Set(Object.keys(REGISTRY));

function fromRegistryEntry(entry: AdapterRegistryEntry): AdapterDefaults {
  // Only runtimeImage is strictly required. The array fields are optional and
  // default to []: the operator emits them with `omitempty`, so a genuinely
  // empty allowFqdns/envKeys/probeCommand arrives as undefined, which is valid
  // (no extra egress / no forwarded secrets / no probe), NOT an error.
  if (!entry.runtimeImage) {
    throw new Error(
      `Adapter "${entry.adapterType}" is missing required runtime field: runtimeImage`,
    );
  }
  return {
    runtimeImage: entry.runtimeImage,
    envKeys: entry.envKeys ?? [],
    allowFqdns: entry.allowFqdns ?? [],
    probeCommand: entry.probeCommand ?? [],
    defaultEnv: entry.defaultEnv,
  };
}

/**
 * Resolve the runtime defaults for an adapter. When a `registry` is supplied it
 * is authoritative (replace semantics): the type MUST be present and complete,
 * else this throws. With no registry, falls back to the built-in REGISTRY.
 */
export function getAdapterDefaults(
  adapterType: string,
  registry?: readonly AdapterRegistryEntry[],
): AdapterDefaults {
  adapterType = normalizeAdapterType(adapterType);
  if (registry && registry.length > 0) {
    const entry = registry.find((e) => e.adapterType === adapterType);
    if (!entry) {
      throw new Error(`Adapter "${adapterType}" is not in the configured adapter registry`);
    }
    return fromRegistryEntry(entry);
  }
  const defaults = REGISTRY[adapterType];
  if (!defaults) {
    throw new Error(`Unknown adapter type: ${adapterType}`);
  }
  return defaults;
}

/** Stable error code for a rejected lease that lacked a required per-run adapter. */
export const RUN_ADAPTER_REQUIRED_CODE = "run_adapter_required" as const;

/**
 * Thrown when strict per-run adapter resolution is enabled but the lease did not
 * carry a per-run adapter type. Falling back to the environment's configured
 * default adapter would be unsafe: the default is a global env value that may be
 * a DIFFERENT harness than the agent will run, so the sandbox image would not
 * match the CLI the server exec's (a gemini agent landing on the opencode image).
 */
export class RunAdapterRequiredError extends Error {
  readonly code = RUN_ADAPTER_REQUIRED_CODE;
  constructor(configAdapterType: string) {
    super(
      `per-run adapter type is required for per-run sandbox execution but was not supplied; refusing to fall back to the environment default adapter "${configAdapterType}", which may be a different harness than the agent will run (the sandbox runtime image would not match the executed CLI)`,
    );
    this.name = "RunAdapterRequiredError";
  }
}

export interface ResolveRunAdapterTypeOptions {
  /**
   * Force rejection of a lease that carries no per-run adapter, for ANY pool
   * (throw {@link RunAdapterRequiredError} instead of falling back to the
   * environment default). This is an explicit operator override on top of the
   * automatic mixed-pool safety below — use it to require the per-run adapter
   * even in a single-adapter environment. Defaults to false.
   */
  requireRunAdapter?: boolean;
  /**
   * The set of adapter types the environment is configured to serve (the
   * enabled entries of the plugin's `adapters` registry). It is the ONLY
   * positive proof of a single-adapter environment: the env-default fallback for
   * an adapter-less lease is permitted ONLY when this declares EXACTLY ONE
   * distinct enabled adapter. Absent or empty proves nothing (the built-in
   * registry still exposes every harness, so an adapter-less run could land on a
   * different harness's image) and more than one entry is an outright
   * mixed-harness pool — both reject the adapter-less lease automatically.
   * Adapter-less callers that must keep working (e.g. connectivity probes) pass
   * an explicit adapter instead of relying on the fallback.
   */
  configuredAdapterTypes?: readonly string[];
}

/**
 * Resolve the adapter type for a single run: prefer the run's adapter (the agent's,
 * from the lease params) so one environment can serve mixed harnesses; fall back to
 * the environment's configured default adapter when the run does not specify one.
 *
 * The image the plugin picks MUST match the harness the server exec's. Never
 * substitute a different harness for an absent per-run adapter. The env-default
 * fallback for an adapter-less lease is permitted ONLY when the config positively
 * proves a single-adapter environment (`configuredAdapterTypes` declares exactly
 * one distinct enabled adapter). Otherwise the lease is rejected:
 *   - An ABSENT or EMPTY `configuredAdapterTypes` proves nothing (the built-in
 *     registry still exposes every harness), so it is treated as UNSAFE.
 *   - A MIXED-harness pool (more than one distinct adapter) is unsafe outright.
 *   - `options.requireRunAdapter` forces the same rejection for any pool.
 * Adapter-less callers that must keep working (connectivity probes) pass an
 * explicit adapter instead of relying on the fallback.
 */
export function resolveRunAdapterType(
  runAdapterType: string | null | undefined,
  configAdapterType: string,
  options: ResolveRunAdapterTypeOptions = {},
): string {
  const trimmed = typeof runAdapterType === "string" ? runAdapterType.trim() : "";
  if (trimmed.length > 0) {
    return normalizeAdapterType(trimmed);
  }
  // Per-run adapter absent. Falling back to the env default is safe ONLY when the
  // config can POSITIVELY prove a single-adapter environment. Prove it from the
  // authoritative adapter set: exactly one distinct enabled adapter. An absent or
  // empty set proves nothing (the built-in registry still exposes every harness,
  // so an adapter-less run could land on a different harness's image), and more
  // than one entry is an outright mixed-harness pool — both are unsafe.
  const distinctConfiguredAdapters = new Set(
    (options.configuredAdapterTypes ?? [])
      .map((type) => (typeof type === "string" ? type.trim() : ""))
      .filter((type) => type.length > 0),
  );
  const provesSingleAdapterEnv = distinctConfiguredAdapters.size === 1;
  if (options.requireRunAdapter || !provesSingleAdapterEnv) {
    throw new RunAdapterRequiredError(configAdapterType);
  }
  return configAdapterType;
}

/**
 * Build the per-run env for the Job: the non-secret `defaultEnv` is the base
 * and the process-env values (the secret API keys named by `envKeys`) override
 * it. Pure for testability.
 */
export function buildAdapterEnv(
  defaults: AdapterDefaults,
  processEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = { ...(defaults.defaultEnv ?? {}) };
  for (const k of defaults.envKeys) {
    const v = processEnv[k];
    if (v) out[k] = v;
  }
  return out;
}
