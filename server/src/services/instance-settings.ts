import type { Db } from "@paperclipai/db";
import { companies, instanceSettings } from "@paperclipai/db";

/**
 * A `Db` or an open transaction handle — the subset of query builders the
 * settings writes use. Lets `update` run inside a caller's transaction so
 * it commits atomically with a sibling write.
 */
type InstanceSettingsTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type InstanceSettingsWriteDb = Pick<
  Db | InstanceSettingsTransaction,
  "select" | "insert" | "update"
>;
import {
  DEFAULT_FEEDBACK_DATA_SHARING_PREFERENCE,
  DEFAULT_BACKUP_RETENTION,
  PAPERCLIP_CLOUD_MANAGED_BY,
  instanceGeneralSettingsSchema,
  type InstanceGeneralSettings,
  instanceExperimentalSettingsSchema,
  type InstanceExperimentalSettings,
  type InstanceExperimentalSettingsWithManaged,
  type ManagedExperimentalFeatureKey,
  type ManagedSettingMetadata,
  type PatchInstanceGeneralSettings,
  type InstanceSettings,
  type PatchInstanceSettings,
  type PatchInstanceExperimentalSettings,
  COMPANY_SETTINGS_SURFACES,
  instanceVisibilitySettingsSchema,
  type InstanceVisibilitySettings,
  type PatchInstanceVisibilitySettings,
  DEFAULT_INSTANCE_VISIBILITY_SETTINGS,
} from "@paperclipai/shared";
import {
  INSTANCE_FEATURE_CATALOG,
  applyOperatorGeneralDefaults,
  objectWithoutDefaults,
  stripOperatorGeneralEchoes,
} from "@paperclipai/shared";
import { eq } from "drizzle-orm";
import { getManagedInstanceConfig, type ManagedInstanceConfig } from "./managed-config.js";
import { getOperatorSettingDefaults } from "./setting-defaults.js";

const DEFAULT_SINGLETON_KEY = "default";
const instanceGeneralSettingsStorageSchema = instanceGeneralSettingsSchema.strip();
const instanceExperimentalSettingsStorageSchema = instanceExperimentalSettingsSchema.strip();
const instanceVisibilitySettingsStorageSchema = instanceVisibilitySettingsSchema.strip();
const TRUTHY_RUNTIME_ENV_VALUES = new Set(["1", "true", "yes", "on"]);

interface InstanceSettingsServiceOptions {
  runtimeEnv?: Record<string, string | undefined>;
  now?: () => Date;
}

type WorktreeRunExecutionSuppressedReason =
  | "not_worktree_runtime"
  | "flag_disabled"
  | "missing_cutoff"
  | "missing_instance_id"
  | "instance_id_mismatch"
  | "settings_read_error";

export type WorktreeRunExecutionActivationState =
  | {
      armed: true;
      cutoff: string;
      activationInstanceId: string;
      reason: null;
    }
  | {
      armed: false;
      cutoff: null;
      activationInstanceId: string | null;
      reason: WorktreeRunExecutionSuppressedReason;
    };

export function isTruthyRuntimeEnvValue(value: string | undefined) {
  return typeof value === "string" && TRUTHY_RUNTIME_ENV_VALUES.has(value.trim().toLowerCase());
}

function getRuntimeInstanceId(env: Record<string, string | undefined>) {
  const instanceId = env.PAPERCLIP_INSTANCE_ID?.trim();
  return instanceId ? instanceId : null;
}

function stripServerManagedExperimentalPatchFields(
  patch: PatchInstanceExperimentalSettings | Record<string, unknown>,
): PatchInstanceExperimentalSettings {
  const {
    worktreeRunExecutionActivatedAt: _ignoredActivatedAt,
    worktreeRunExecutionActivationInstanceId: _ignoredActivationInstanceId,
    ...patchable
  } = patch as Record<string, unknown>;
  return patchable as PatchInstanceExperimentalSettings;
}

const OVERRIDES_ENV_VAR = "PAPERCLIP_INSTANCE_SETTINGS_OVERRIDES";

export interface InstanceSettingsOverrides {
  general: Record<string, unknown>;
  experimental: Record<string, unknown>;
  visibility: Record<string, unknown>;
}

function emptyOverrides(): InstanceSettingsOverrides {
  return { general: {}, experimental: {}, visibility: {} };
}

const warnedOverrideInputs = new Set<string>();

function warnOverridesOnce(cacheKey: string, message: string) {
  if (warnedOverrideInputs.has(cacheKey)) return;
  warnedOverrideInputs.add(cacheKey);
  console.warn(message);
}

/**
 * Parses PAPERCLIP_INSTANCE_SETTINGS_OVERRIDES (a JSON object with optional
 * "general" / "experimental" / "visibility" sections). Overridden keys win over
 * the stored instance settings at read time, letting operators pin settings
 * declaratively from deployment config. Invalid JSON or an invalid section is
 * warned about once and ignored (the stored settings apply). The "visibility"
 * section is fork-only (upstream has no visibility concept), included so
 * overrides are internally consistent across all instance settings sections.
 */
export function parseInstanceSettingsOverrides(
  env: Record<string, string | undefined> = process.env,
): InstanceSettingsOverrides {
  const raw = env[OVERRIDES_ENV_VAR]?.trim();
  if (!raw) return emptyOverrides();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warnOverridesOnce(raw, `${OVERRIDES_ENV_VAR} is not valid JSON; ignoring overrides`);
    return emptyOverrides();
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    warnOverridesOnce(raw, `${OVERRIDES_ENV_VAR} must be a JSON object; ignoring overrides`);
    return emptyOverrides();
  }

  const sections = parsed as Record<string, unknown>;
  // Zod 4 keeps a field `.default()` active through `.partial()`, so a plain
  // `.partial()` here would report every absent key at its default and the
  // overlay would overwrite stored settings the operator never mentioned.
  const sectionSchemas = {
    general: objectWithoutDefaults(instanceGeneralSettingsSchema).partial().strip(),
    experimental: objectWithoutDefaults(instanceExperimentalSettingsSchema).partial().strip(),
    visibility: objectWithoutDefaults(instanceVisibilitySettingsSchema).partial().strip(),
  } as const;

  const result = emptyOverrides();
  for (const key of ["general", "experimental", "visibility"] as const) {
    if (sections[key] === undefined) continue;
    const sectionParsed = sectionSchemas[key].safeParse(sections[key]);
    if (!sectionParsed.success) {
      warnOverridesOnce(
        `${raw}:${key}`,
        `${OVERRIDES_ENV_VAR}.${key} failed validation; ignoring this section`,
      );
      continue;
    }
    result[key] = sectionParsed.data as Record<string, unknown>;
  }
  result.experimental = stripServerManagedExperimentalPatchFields(
    result.experimental,
  ) as Record<string, unknown>;
  return result;
}

/**
 * Override-aware resolution: normalize the stored value, spread the env
 * overrides on top, and re-normalize. Nested objects (backupRetention) are
 * overridden whole, matching the existing shallow patch semantics.
 */
export function resolveGeneralSettings(
  raw: unknown,
  overrides: Record<string, unknown> = {},
): InstanceGeneralSettings {
  return normalizeGeneralSettings({ ...normalizeGeneralSettings(raw), ...overrides });
}

export function resolveExperimentalSettings(
  raw: unknown,
  overrides: Record<string, unknown> = {},
): InstanceExperimentalSettings {
  return normalizeExperimentalSettings({ ...normalizeExperimentalSettings(raw), ...overrides });
}

/** Env-overridden keys are read-time-forced and must never persist via a patch. */
export function stripOverriddenPatchKeys<T extends Record<string, unknown>>(
  patch: T,
  overrideKeys: string[],
): T {
  if (overrideKeys.length === 0) return patch;
  const next: Record<string, unknown> = { ...patch };
  for (const key of overrideKeys) delete next[key];
  return next as T;
}

export function applyExperimentalSettingsPatch(
  current: unknown,
  patch: PatchInstanceExperimentalSettings | Record<string, unknown>,
  options: InstanceSettingsServiceOptions = {},
): InstanceExperimentalSettings {
  const previousExperimental = normalizeExperimentalSettings(current);
  const patchable = stripServerManagedExperimentalPatchFields(patch);
  const nextExperimental = normalizeExperimentalSettings({
    ...previousExperimental,
    ...patchable,
  });
  const hasWorktreeRunExecutionPatch = Object.prototype.hasOwnProperty.call(
    patchable,
    "enableWorktreeRunExecution",
  );

  if (!hasWorktreeRunExecutionPatch) {
    return nextExperimental;
  }

  if (nextExperimental.enableWorktreeRunExecution !== true) {
    return {
      ...nextExperimental,
      worktreeRunExecutionActivatedAt: null,
      worktreeRunExecutionActivationInstanceId: null,
    };
  }

  if (previousExperimental.enableWorktreeRunExecution === true) {
    return nextExperimental;
  }

  const runtimeEnv = options.runtimeEnv ?? process.env;
  if (!isTruthyRuntimeEnvValue(runtimeEnv.PAPERCLIP_IN_WORKTREE)) {
    return nextExperimental;
  }

  return {
    ...nextExperimental,
    worktreeRunExecutionActivatedAt: (options.now ?? (() => new Date()))().toISOString(),
    worktreeRunExecutionActivationInstanceId: getRuntimeInstanceId(runtimeEnv),
  };
}

function suppressWorktreeRunExecution(
  reason: WorktreeRunExecutionSuppressedReason,
  activationInstanceId: string | null = null,
): WorktreeRunExecutionActivationState {
  return {
    armed: false,
    cutoff: null,
    activationInstanceId,
    reason,
  };
}

export function resolveWorktreeRunExecutionActivation(
  experimental: InstanceExperimentalSettings,
  currentInstanceId: string | null | undefined,
): WorktreeRunExecutionActivationState {
  if (experimental.enableWorktreeRunExecution !== true) {
    return suppressWorktreeRunExecution(
      "flag_disabled",
      experimental.worktreeRunExecutionActivationInstanceId,
    );
  }
  if (!experimental.worktreeRunExecutionActivatedAt) {
    return suppressWorktreeRunExecution(
      "missing_cutoff",
      experimental.worktreeRunExecutionActivationInstanceId,
    );
  }
  if (!currentInstanceId) {
    return suppressWorktreeRunExecution(
      "missing_instance_id",
      experimental.worktreeRunExecutionActivationInstanceId,
    );
  }
  if (experimental.worktreeRunExecutionActivationInstanceId !== currentInstanceId) {
    return suppressWorktreeRunExecution(
      "instance_id_mismatch",
      experimental.worktreeRunExecutionActivationInstanceId,
    );
  }
  return {
    armed: true,
    cutoff: experimental.worktreeRunExecutionActivatedAt,
    activationInstanceId: currentInstanceId,
    reason: null,
  };
}

export async function resolveWorktreeRunExecutionActivationState(options: {
  getExperimental: () => Promise<InstanceExperimentalSettings>;
  runtimeEnv?: Record<string, string | undefined>;
}): Promise<WorktreeRunExecutionActivationState> {
  const runtimeEnv = options.runtimeEnv ?? process.env;
  if (!isTruthyRuntimeEnvValue(runtimeEnv.PAPERCLIP_IN_WORKTREE)) {
    return suppressWorktreeRunExecution("not_worktree_runtime");
  }
  try {
    return resolveWorktreeRunExecutionActivation(
      await options.getExperimental(),
      getRuntimeInstanceId(runtimeEnv),
    );
  } catch {
    return suppressWorktreeRunExecution("settings_read_error");
  }
}

function normalizeGeneralSettings(raw: unknown): InstanceGeneralSettings {
  const parsed = instanceGeneralSettingsStorageSchema.safeParse(raw ?? {});
  if (parsed.success) {
    return {
      censorUsernameInLogs: parsed.data.censorUsernameInLogs ?? false,
      keyboardShortcuts: parsed.data.keyboardShortcuts ?? false,
      feedbackDataSharingPreference:
        parsed.data.feedbackDataSharingPreference ?? DEFAULT_FEEDBACK_DATA_SHARING_PREFERENCE,
      backupRetention: parsed.data.backupRetention ?? DEFAULT_BACKUP_RETENTION,
      // Absent => unrestricted; only carry through an explicit policy.
      ...(parsed.data.executionMode ? { executionMode: parsed.data.executionMode } : {}),
    };
  }
  return {
    censorUsernameInLogs: false,
    keyboardShortcuts: false,
    feedbackDataSharingPreference: DEFAULT_FEEDBACK_DATA_SHARING_PREFERENCE,
    backupRetention: DEFAULT_BACKUP_RETENTION,
  };
}

export function normalizeExperimentalSettings(raw: unknown): InstanceExperimentalSettings {
  const parsed = instanceExperimentalSettingsStorageSchema.safeParse(raw ?? {});
  if (parsed.success) {
    return {
      enableEnvironments: parsed.data.enableEnvironments ?? false,
      enableNativeRunner: parsed.data.enableNativeRunner ?? true,
      enableManagedSandboxOnly: parsed.data.enableManagedSandboxOnly ?? false,
      enableIsolatedWorkspaces: parsed.data.enableIsolatedWorkspaces ?? false,
      enableStreamlinedLeftNavigation: parsed.data.enableStreamlinedLeftNavigation ?? true,
      enableStreamlinedUi: parsed.data.enableStreamlinedUi ?? true,
      // Apps graduated from Experimental. Ignore historical off values while
      // continuing to accept the compatibility key in stored settings.
      enableApps: true,
      enableChatConnectors: parsed.data.enableChatConnectors ?? false,
      enablePipelines: parsed.data.enablePipelines ?? false,
      enableCases: parsed.data.enableCases ?? false,
      enableAgentChat: parsed.data.enableAgentChat ?? false,
      enableConferenceRoomChat: parsed.data.enableConferenceRoomChat ?? false,
      enableClassicTaskInterface: parsed.data.enableClassicTaskInterface ?? false,
      enableIssuePlanDecompositions: parsed.data.enableIssuePlanDecompositions ?? false,
      enableExperimentalFileViewer: parsed.data.enableExperimentalFileViewer ?? false,
      enableCloudSync: parsed.data.enableCloudSync ?? false,
      enableExternalObjects: parsed.data.enableExternalObjects ?? false,
      enableSmokeLab: parsed.data.enableSmokeLab ?? false,
      enableBuiltInAgents: parsed.data.enableBuiltInAgents ?? false,
      enableBetaSkills: parsed.data.enableBetaSkills ?? false,
      enableSummaries: parsed.data.enableSummaries ?? false,
      enableStatusCards: parsed.data.enableStatusCards ?? false,
      enableDecisions: parsed.data.enableDecisions ?? false,
      enableGoalsSidebarLink: parsed.data.enableGoalsSidebarLink ?? false,
      enableServerInfoDebugView: parsed.data.enableServerInfoDebugView ?? false,
      enablePaperclipDeveloperMode: parsed.data.enablePaperclipDeveloperMode ?? false,
      enableSimplifiedEnglishInteractions: parsed.data.enableSimplifiedEnglishInteractions ?? false,
      enableFirstTaskPlanProposal: parsed.data.enableFirstTaskPlanProposal ?? false,
      autoRestartDevServerWhenIdle: parsed.data.autoRestartDevServerWhenIdle ?? false,
      cloudBilling:
        process.env.PAPERCLIP_CLOUD_BILLING === "true" ||
        (parsed.data.cloudBilling ?? false),
      cloudTrialBanner:
        process.env.PAPERCLIP_CLOUD_TRIAL_BANNER === "true" ||
        (parsed.data.cloudTrialBanner ?? false),
      enableWorkspaceBranchReconcileForward: parsed.data.enableWorkspaceBranchReconcileForward ?? true,
      enableWorkspaceDirtyQuarantineRepair: parsed.data.enableWorkspaceDirtyQuarantineRepair ?? true,
      enableOwnerInstanceAdmin: parsed.data.enableOwnerInstanceAdmin ?? false,
      enableSandboxDuplexBridge: parsed.data.enableSandboxDuplexBridge ?? false,
      enableRunnerPreviewIngress: parsed.data.enableRunnerPreviewIngress ?? false,
      enableWorktreeRunExecution: parsed.data.enableWorktreeRunExecution ?? false,
      worktreeRunExecutionActivatedAt: parsed.data.worktreeRunExecutionActivatedAt ?? null,
      worktreeRunExecutionActivationInstanceId:
        parsed.data.worktreeRunExecutionActivationInstanceId ?? null,
    };
  }
  return {
    enableEnvironments: false,
    enableNativeRunner: true,
    enableManagedSandboxOnly: false,
    enableIsolatedWorkspaces: false,
    enableStreamlinedLeftNavigation: true,
    enableStreamlinedUi: true,
    enableApps: true,
    enableChatConnectors: false,
    enablePipelines: false,
    enableCases: false,
    enableAgentChat: false,
    enableConferenceRoomChat: false,
    enableClassicTaskInterface: false,
    enableIssuePlanDecompositions: false,
    enableExperimentalFileViewer: false,
    enableCloudSync: false,
    enableExternalObjects: false,
    enableSmokeLab: false,
    enableBuiltInAgents: false,
    enableBetaSkills: false,
    enableSummaries: false,
    enableStatusCards: false,
    enableDecisions: false,
    enableGoalsSidebarLink: false,
    enableServerInfoDebugView: false,
    enablePaperclipDeveloperMode: false,
    enableSimplifiedEnglishInteractions: false,
    enableFirstTaskPlanProposal: false,
    autoRestartDevServerWhenIdle: false,
    cloudBilling: process.env.PAPERCLIP_CLOUD_BILLING === "true",
    cloudTrialBanner: process.env.PAPERCLIP_CLOUD_TRIAL_BANNER === "true",
    enableWorkspaceBranchReconcileForward: true,
    enableWorkspaceDirtyQuarantineRepair: true,
    enableOwnerInstanceAdmin: false,
    enableSandboxDuplexBridge: false,
    enableRunnerPreviewIngress: false,
    enableWorktreeRunExecution: false,
    worktreeRunExecutionActivatedAt: null,
    worktreeRunExecutionActivationInstanceId: null,
  };
}

export function normalizeVisibilitySettings(raw: unknown): InstanceVisibilitySettings {
  const parsed = instanceVisibilitySettingsStorageSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    // Corrupt row: fall back to the spec default (everything exposed),
    // mirroring normalizeGeneralSettings/normalizeExperimentalSettings.
    return {
      ...DEFAULT_INSTANCE_VISIBILITY_SETTINGS,
      companySurfaces: [...DEFAULT_INSTANCE_VISIBILITY_SETTINGS.companySurfaces],
    };
  }
  const stored = parsed.data.companySurfaces;
  // Canonical order + dedupe: intersect the constant list with the stored set.
  return {
    companySurfaces: COMPANY_SETTINGS_SURFACES.filter((surface) => stored.includes(surface)),
  };
}

/**
 * Override-aware resolution for visibility settings, symmetric with
 * resolveGeneralSettings/resolveExperimentalSettings above. Upstream has no
 * visibility concept (it's fork-only), so this keeps env overrides
 * internally consistent across all three settings sections.
 */
export function resolveVisibilitySettings(
  raw: unknown,
  overrides: Record<string, unknown> = {},
): InstanceVisibilitySettings {
  return normalizeVisibilitySettings({ ...normalizeVisibilitySettings(raw), ...overrides });
}

export type ManagedExperimentalKeyMetadata = Partial<
  Record<ManagedExperimentalFeatureKey, ManagedSettingMetadata>
>;

/**
 * Overlay the cloud managed-config feature values over normalized settings.
 *
 * Read-time precedence: code floor (cloud) > managed overlay > tenant DB
 * value > schema default. (No code floors are expressed as flags today —
 * floors are enforced in code at the guarded routes, independent of any
 * flag value.) The overlay is deliberately never persisted: it re-asserts on
 * every read, so a DB restore or manual row edit cannot resurrect a
 * capability the harness has disabled.
 */
export function applyManagedExperimentalOverlay(
  experimental: InstanceExperimentalSettings,
  managedConfig: ManagedInstanceConfig | null,
): { experimental: InstanceExperimentalSettings; managedKeys: ManagedExperimentalKeyMetadata } {
  if (!managedConfig) return { experimental, managedKeys: {} };
  const next: InstanceExperimentalSettings = { ...experimental };
  const managedKeys: ManagedExperimentalKeyMetadata = {};
  for (const [key, value] of Object.entries(managedConfig.features) as Array<
    [ManagedExperimentalFeatureKey, boolean]
  >) {
    // Existing Cloud stack configs may still carry enableApps. Accept the
    // document during rollout, but never let the retired flag disable Apps.
    if (key === "enableApps") continue;
    next[key] = value;
    managedKeys[key] = { managed: true, managedBy: PAPERCLIP_CLOUD_MANAGED_BY };
  }
  return { experimental: next, managedKeys };
}

/**
 * Keep self-hosted-only defaults out of Cloud.
 *
 * The experimental schema carries one default per flag, and the feature
 * catalog pins it to `selfHostedDefault`. A flag that is on by default for
 * self-hosted but off by default for Cloud (`selfHostedDefault: true`,
 * `cloudDefault: false`) would therefore normalize to "on" for a managed
 * instance whose tenant row and managed overlay both leave it unset. Re-assert
 * the declared Cloud default for exactly those flags. An explicit tenant value
 * or a managed feature value still wins (the overlay is applied afterwards).
 */
export function applyCloudCatalogDefaults(
  experimental: InstanceExperimentalSettings,
  rawStored: unknown,
  managedConfig: ManagedInstanceConfig | null,
): InstanceExperimentalSettings {
  if (!managedConfig) return experimental;
  const stored =
    rawStored && typeof rawStored === "object" && !Array.isArray(rawStored)
      ? (rawStored as Record<string, unknown>)
      : {};
  const next: InstanceExperimentalSettings = { ...experimental };
  for (const [key, entry] of Object.entries(INSTANCE_FEATURE_CATALOG)) {
    if (entry.cloudDefault !== false || entry.selfHostedDefault !== true) continue;
    if (typeof stored[key] === "boolean") continue;
    if (typeof managedConfig.features[key as ManagedExperimentalFeatureKey] === "boolean") continue;
    (next as unknown as Record<string, unknown>)[key] = false;
  }
  return next;
}

/**
 * Keep the write path from freezing a self-hosted default into a Cloud row.
 *
 * `updateExperimental` persists the whole normalized object, and the schema
 * normalizes an omitted flag to its self-hosted default. Without this step an
 * unrelated experimental write (say, turning on pipelines) would store
 * `enableNativeRunner: true` on a managed instance whose tenant row had never
 * mentioned the flag; every later read would then treat the stored boolean as
 * an explicit tenant choice and stop re-asserting the Cloud default.
 *
 * For each guarded flag (see `applyCloudCatalogDefaults`), the stored key is
 * left absent unless the tenant already stored a boolean or this patch sets
 * the flag to something other than the Cloud default. A patch value equal to
 * the Cloud default is a full-GET echo of the read-time overlay, not a
 * choice, and is stripped the same way `stripOperatorGeneralEchoes` treats
 * operator defaults. Self-hosted rows are returned untouched.
 */
export function stripCloudCatalogDefaultEchoes(
  rawStored: unknown,
  patch: PatchInstanceExperimentalSettings | Record<string, unknown>,
  next: InstanceExperimentalSettings,
  managedConfig: ManagedInstanceConfig | null,
): Partial<InstanceExperimentalSettings> {
  if (!managedConfig) return next;
  const stored =
    rawStored && typeof rawStored === "object" && !Array.isArray(rawStored)
      ? (rawStored as Record<string, unknown>)
      : {};
  const patchRecord = patch as Record<string, unknown>;
  const result: Record<string, unknown> = { ...next };
  for (const [key, entry] of Object.entries(INSTANCE_FEATURE_CATALOG)) {
    if (entry.cloudDefault !== false || entry.selfHostedDefault !== true) continue;
    if (typeof stored[key] === "boolean") continue;
    if (
      Object.prototype.hasOwnProperty.call(patchRecord, key) &&
      typeof patchRecord[key] === "boolean" &&
      patchRecord[key] !== entry.cloudDefault
    ) {
      continue;
    }
    delete result[key];
  }
  return result as Partial<InstanceExperimentalSettings>;
}

export function instanceSettingsService(db: Db, options: InstanceSettingsServiceOptions = {}) {
  const overrides = parseInstanceSettingsOverrides(options.runtimeEnv ?? process.env);
  // Fail closed: a malformed PAPERCLIP_MANAGED_CONFIG throws here (and at
  // boot in index.ts) rather than silently running without the overlay.
  const managedConfig = getManagedInstanceConfig(options.runtimeEnv ?? process.env);
  // Same posture for PAPERCLIP_SETTING_DEFAULTS: parsed once, applied per
  // read, never persisted (see applyOperatorGeneralDefaults) — including on
  // the write path, where a full-GET echo of the overlaid value is stripped
  // back to the schema default (see stripOperatorGeneralEchoes).
  const operatorDefaults = getOperatorSettingDefaults(options.runtimeEnv ?? process.env);

  function toGeneralView(raw: unknown): InstanceGeneralSettings {
    return applyOperatorGeneralDefaults(normalizeGeneralSettings(raw), operatorDefaults);
  }

  function toExperimentalView(raw: unknown): InstanceExperimentalSettingsWithManaged {
    const { experimental, managedKeys } = applyManagedExperimentalOverlay(
      applyCloudCatalogDefaults(normalizeExperimentalSettings(raw), raw, managedConfig),
      managedConfig,
    );
    // Self-hosted responses stay byte-identical: no managedKeys field at all.
    return managedConfig ? { ...experimental, managedKeys } : experimental;
  }

  function toInstanceSettings(row: typeof instanceSettings.$inferSelect): InstanceSettings {
    return {
      id: row.id,
      defaultEnvironmentId: row.defaultEnvironmentId ?? null,
      general: toGeneralView(row.general),
      experimental: toExperimentalView(row.experimental),
      // Fork-only section; upstream's view has no visibility concept, so it is
      // resolved here rather than being dropped from every settings response.
      visibility: resolveVisibilitySettings(row.visibility, overrides.visibility),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    } as InstanceSettings;
  }
  async function getOrCreateRow(runner: InstanceSettingsWriteDb = db) {
    const existing = await runner
      .select()
      .from(instanceSettings)
      .where(eq(instanceSettings.singletonKey, DEFAULT_SINGLETON_KEY))
      .then((rows) => rows[0] ?? null);
    if (existing) return existing;

    const now = new Date();
    const [created] = await runner
      .insert(instanceSettings)
      .values({
        singletonKey: DEFAULT_SINGLETON_KEY,
        general: {},
        experimental: {},
        visibility: {},
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [instanceSettings.singletonKey],
        set: {
          updatedAt: now,
        },
      })
      .returning();

    if (created) return created;

    const raced = await runner
      .select()
      .from(instanceSettings)
      .where(eq(instanceSettings.singletonKey, DEFAULT_SINGLETON_KEY))
      .then((rows) => rows[0] ?? null);
    if (raced) return raced;

    throw new Error("Failed to initialize instance settings row");
  }

  return {
    get: async (): Promise<InstanceSettings> => toInstanceSettings(await getOrCreateRow()),

    update: async (
      patch: PatchInstanceSettings,
      writeOptions?: { db?: InstanceSettingsWriteDb },
    ): Promise<InstanceSettings> => {
      // The write may run inside a caller-supplied transaction so it commits
      // atomically with a sibling write (e.g. clearing the managed-default
      // stamp on the environment row alongside a defaultEnvironmentId
      // change). Reads use the same runner so the row is visible to the tx.
      const runner = writeOptions?.db ?? db;
      const current = await getOrCreateRow(runner);
      const now = new Date();
      const [updated] = await runner
        .update(instanceSettings)
        .set({
          ...(Object.prototype.hasOwnProperty.call(patch, "defaultEnvironmentId")
            ? { defaultEnvironmentId: patch.defaultEnvironmentId ?? null }
            : {}),
          updatedAt: now,
        })
        .where(eq(instanceSettings.id, current.id))
        .returning();
      return toInstanceSettings(updated ?? current);
    },

    getGeneral: async (
      readOptions?: { db?: InstanceSettingsWriteDb },
    ): Promise<InstanceGeneralSettings> => {
      const row = await getOrCreateRow(readOptions?.db);
      return toGeneralView(row.general);
    },

    getExperimental: async (): Promise<InstanceExperimentalSettingsWithManaged> => {
      const row = await getOrCreateRow();
      return toExperimentalView(row.experimental);
    },

    getVisibility: async (): Promise<InstanceVisibilitySettings> => {
      const row = await getOrCreateRow();
      return resolveVisibilitySettings(row.visibility, overrides.visibility);
    },

    updateGeneral: async (patch: PatchInstanceGeneralSettings): Promise<InstanceSettings> => {
      const current = await getOrCreateRow();
      const storedGeneral = normalizeGeneralSettings(current.general);
      // A full-GET echo carries the overlaid operator value for a field the
      // user never chose; stripping it keeps the overlay strictly read-time,
      // so changing or unsetting the variable later still takes effect.
      const nextGeneral = stripOperatorGeneralEchoes(
        storedGeneral,
        normalizeGeneralSettings({ ...storedGeneral, ...patch }),
        operatorDefaults,
      );
      const now = new Date();
      const [updated] = await db
        .update(instanceSettings)
        .set({
          general: { ...nextGeneral },
          updatedAt: now,
        })
        .where(eq(instanceSettings.id, current.id))
        .returning();
      return toInstanceSettings(updated ?? current);
    },

    updateExperimental: async (patch: PatchInstanceExperimentalSettings): Promise<InstanceSettings> => {
      const current = await getOrCreateRow();
      const effectivePatch = stripOverriddenPatchKeys(
        patch as Record<string, unknown>,
        Object.keys(overrides.experimental),
      ) as PatchInstanceExperimentalSettings;
      // Guarded Cloud flags stay absent from the row unless chosen, so the
      // read-time catalog default keeps applying (see stripCloudCatalogDefaultEchoes).
      const nextExperimental = stripCloudCatalogDefaultEchoes(
        current.experimental,
        effectivePatch,
        applyExperimentalSettingsPatch(current.experimental, effectivePatch, options),
        managedConfig,
      );
      const now = new Date();
      const [updated] = await db
        .update(instanceSettings)
        .set({
          experimental: { ...nextExperimental },
          updatedAt: now,
        })
        .where(eq(instanceSettings.id, current.id))
        .returning();
      return toInstanceSettings(updated ?? current);
    },

    updateVisibility: async (patch: PatchInstanceVisibilitySettings): Promise<InstanceSettings> => {
      const current = await getOrCreateRow();
      const effectivePatch = stripOverriddenPatchKeys(
        patch as Record<string, unknown>,
        Object.keys(overrides.visibility),
      ) as PatchInstanceVisibilitySettings;
      const nextVisibility = normalizeVisibilitySettings({
        ...normalizeVisibilitySettings(current.visibility),
        ...effectivePatch,
      });
      const now = new Date();
      const [updated] = await db
        .update(instanceSettings)
        .set({
          visibility: { ...nextVisibility },
          updatedAt: now,
        })
        .where(eq(instanceSettings.id, current.id))
        .returning();
      return toInstanceSettings(updated ?? current);
    },

    listCompanyIds: async (): Promise<string[]> =>
      db
        .select({ id: companies.id })
        .from(companies)
        .then((rows) => rows.map((row) => row.id)),
  };
}
