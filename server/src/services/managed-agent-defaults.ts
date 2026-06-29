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
