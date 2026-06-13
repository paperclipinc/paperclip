export interface ManagedAgentDefaults {
  adapterType: string;
  model: string | null;
}

function asNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function resolveManagedAgentDefaults(
  env: Record<string, string | undefined> = process.env,
): ManagedAgentDefaults | null {
  const adapterType = env.PAPERCLIP_MANAGED_DEFAULT_ADAPTER?.trim();
  if (!adapterType) return null;
  const model = env.PAPERCLIP_MANAGED_DEFAULT_MODEL?.trim();
  return { adapterType, model: model && model.length > 0 ? model : null };
}

export function applyManagedAgentDefaults(args: {
  requestedAdapterType: unknown;
  adapterConfig: Record<string, unknown>;
  managed: ManagedAgentDefaults | null;
}): { adapterType: unknown; adapterConfig: Record<string, unknown> } {
  const { managed } = args;
  let adapterType = args.requestedAdapterType;
  const adapterConfig = { ...args.adapterConfig };
  if (!managed) return { adapterType, adapterConfig };

  if (!asNonEmptyString(adapterType)) {
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
