export interface ManagedAgentDefaults {
  adapterType: string;
  model: string | null;
}

function asNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

// The agent create schema defaults an omitted adapterType to "process" (the inert
// generic adapter). In managed mode we treat that, plus empty/undefined, as
// "unspecified" so the managed default adapter is injected.
const UNSPECIFIED_ADAPTER_SENTINEL = "process";

function isUnspecifiedAdapter(value: unknown): boolean {
  if (typeof value !== "string") return true;
  const trimmed = value.trim();
  return trimmed.length === 0 || trimmed === UNSPECIFIED_ADAPTER_SENTINEL;
}

export function resolveManagedAgentDefaults(
  env: Record<string, string | undefined> = process.env,
): ManagedAgentDefaults | null {
  const adapterType = env.PAPERCLIP_MANAGED_DEFAULT_ADAPTER?.trim();
  if (!adapterType) return null;
  const model = env.PAPERCLIP_MANAGED_DEFAULT_MODEL?.trim();
  return { adapterType, model: model && model.length > 0 ? model : null };
}

/**
 * Returns a warning message string when PAPERCLIP_MANAGED_EXPERIENCE is enabled
 * but PAPERCLIP_MANAGED_DEFAULT_ADAPTER is not set, causing managed agents to be
 * created without an injected adapter or model. Returns null when the config is
 * consistent or managed experience is not enabled.
 */
export function warnIfManagedExperienceMisconfigured(
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (env.PAPERCLIP_MANAGED_EXPERIENCE !== "true") return null;
  if (resolveManagedAgentDefaults(env) !== null) return null;
  return (
    "managedExperience is enabled (PAPERCLIP_MANAGED_EXPERIENCE=true) but" +
    " PAPERCLIP_MANAGED_DEFAULT_ADAPTER is unset; managed agents will be" +
    " created without an injected adapter or model." +
    " Set PAPERCLIP_MANAGED_DEFAULT_ADAPTER and PAPERCLIP_MANAGED_DEFAULT_MODEL."
  );
}

/**
 * Resolve the managed defaults that a RUN must be forced onto, but only when the
 * managed experience is actually enabled (PAPERCLIP_MANAGED_EXPERIENCE=true).
 *
 * Unlike {@link resolveManagedAgentDefaults} (which only requires the default
 * adapter env to be set, and is used at agent-CREATE time to fill an unspecified
 * adapter), this gate is what the run path uses to decide whether to OVERRIDE a
 * stored adapter. In managed mode the only adapter/model that is actually
 * provisioned is the managed one, so a legacy agent created with a different
 * adapter (e.g. codex_local, before managed mode was fixed) would otherwise fail
 * at run time ("no Codex credentials provisioned ... OPENAI_API_KEY is empty").
 */
export function resolveManagedRunDefaults(
  env: Record<string, string | undefined> = process.env,
): ManagedAgentDefaults | null {
  if (env.PAPERCLIP_MANAGED_EXPERIENCE !== "true") return null;
  return resolveManagedAgentDefaults(env);
}

/**
 * Force an agent's effective adapter/model onto the managed defaults for a run.
 *
 * This is applied at run-resolution time only — it returns a NEW object and never
 * mutates the stored agent row. When `managed` is null (managed experience off or
 * misconfigured) it is a no-op and returns the agent unchanged, so non-managed
 * deployments behave exactly as before.
 *
 * The override is unconditional (unlike the soft fill in
 * {@link applyManagedAgentDefaults}): the stored adapterType is REPLACED with the
 * managed adapter and `adapterConfig.model` is REPLACED with the managed model,
 * regardless of what the agent row stores. This makes a legacy Codex/Claude/etc.
 * agent transparently run on the managed adapter + model.
 */
export function overrideAgentForManagedRun<
  T extends { adapterType: string; adapterConfig: Record<string, unknown> | null },
>(agent: T, managed: ManagedAgentDefaults | null): T {
  if (!managed) return agent;
  const adapterConfig: Record<string, unknown> = { ...(agent.adapterConfig ?? {}) };
  if (managed.model) {
    adapterConfig.model = managed.model;
  }
  if (agent.adapterType === managed.adapterType && agent.adapterConfig?.model === adapterConfig.model) {
    // Already on the managed adapter + model; avoid allocating a changed row.
    return agent;
  }
  return { ...agent, adapterType: managed.adapterType, adapterConfig };
}

export function applyManagedAgentDefaults(args: {
  requestedAdapterType: string | null | undefined;
  adapterConfig: Record<string, unknown>;
  managed: ManagedAgentDefaults | null;
}): { adapterType: string | null | undefined; adapterConfig: Record<string, unknown> } {
  const { managed } = args;
  let adapterType = args.requestedAdapterType;
  const adapterConfig = { ...args.adapterConfig };
  if (!managed) return { adapterType, adapterConfig };

  if (isUnspecifiedAdapter(adapterType)) {
    adapterType = managed.adapterType;
  }
  if (
    managed.model &&
    adapterType === managed.adapterType &&
    !asNonEmptyString(adapterConfig.model)
  ) {
    adapterConfig.model = managed.model;
  }
  return { adapterType, adapterConfig };
}
