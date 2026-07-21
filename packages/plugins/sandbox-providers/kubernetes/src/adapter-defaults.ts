import type { AdapterRegistryEntry } from "./adapter-registry.js";

export interface AdapterDefaults {
  runtimeImage: string;
  envKeys: string[];
  allowFqdns: string[];
  probeCommand: string[];
  /** Non-secret env injected as the base layer for the Job (process-env wins on top). */
  defaultEnv?: Record<string, string>;
}

const REGISTRY: Record<string, AdapterDefaults> = {
  claude_local: {
    runtimeImage: "ghcr.io/paperclipai/agent-runtime-claude:v1",
    envKeys: ["ANTHROPIC_API_KEY"],
    allowFqdns: ["api.anthropic.com"],
    probeCommand: ["claude", "--version"],
  },
  codex_local: {
    runtimeImage: "ghcr.io/paperclipai/agent-runtime-codex:v1",
    envKeys: ["OPENAI_API_KEY"],
    allowFqdns: ["api.openai.com"],
    probeCommand: ["codex", "--version"],
  },
  gemini_local: {
    runtimeImage: "ghcr.io/paperclipai/agent-runtime-gemini:v1",
    envKeys: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
    allowFqdns: ["generativelanguage.googleapis.com"],
    probeCommand: ["gemini", "--version"],
  },
  cursor_local: {
    runtimeImage: "ghcr.io/paperclipai/agent-runtime-cursor:v1",
    envKeys: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
    allowFqdns: ["api.anthropic.com", "api.openai.com"],
    probeCommand: ["cursor-agent", "--version"],
  },
  opencode_local: {
    runtimeImage: "ghcr.io/paperclipai/agent-runtime-opencode:v1",
    envKeys: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"],
    allowFqdns: ["api.anthropic.com", "api.openai.com", "openrouter.ai"],
    probeCommand: ["opencode", "--version"],
  },
  pi_local: {
    runtimeImage: "ghcr.io/paperclipai/agent-runtime-pi:v1",
    envKeys: ["ANTHROPIC_API_KEY"],
    allowFqdns: ["api.anthropic.com"],
    probeCommand: ["pi", "--version"],
  },
};

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
   * Require an explicit per-run adapter. When true and the run does not supply
   * one, throw {@link RunAdapterRequiredError} instead of silently falling back
   * to the environment default — the correct posture for a mixed-harness
   * managed pool where the default is unlikely to match the agent's harness.
   * Defaults to false to preserve single-adapter environments and connectivity
   * probes that legitimately carry no per-run adapter.
   */
  requireRunAdapter?: boolean;
}

/**
 * Resolve the adapter type for a single run: prefer the run's adapter (the agent's,
 * from the lease params) so one environment can serve mixed harnesses; fall back to
 * the environment's configured default adapter when the run does not specify one.
 *
 * The image the plugin picks MUST match the harness the server exec's. Never
 * substitute a different harness: when `options.requireRunAdapter` is set, a run
 * without a per-run adapter is rejected rather than silently mapped to the
 * environment default (which may be a different harness's runtime image).
 */
export function resolveRunAdapterType(
  runAdapterType: string | null | undefined,
  configAdapterType: string,
  options: ResolveRunAdapterTypeOptions = {},
): string {
  const trimmed = typeof runAdapterType === "string" ? runAdapterType.trim() : "";
  if (trimmed.length > 0) {
    return trimmed;
  }
  if (options.requireRunAdapter) {
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
