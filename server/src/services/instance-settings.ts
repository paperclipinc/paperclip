import type { Db } from "@paperclipai/db";
import { companies, instanceSettings } from "@paperclipai/db";
import {
  DEFAULT_FEEDBACK_DATA_SHARING_PREFERENCE,
  DEFAULT_BACKUP_RETENTION,
  DEFAULT_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS,
  instanceGeneralSettingsSchema,
  type InstanceGeneralSettings,
  instanceExperimentalSettingsSchema,
  type InstanceExperimentalSettings,
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
import { eq } from "drizzle-orm";

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
  const sectionSchemas = {
    general: instanceGeneralSettingsSchema.partial().strip(),
    experimental: instanceExperimentalSettingsSchema.partial().strip(),
    visibility: instanceVisibilitySettingsSchema.partial().strip(),
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
      enableIsolatedWorkspaces: parsed.data.enableIsolatedWorkspaces ?? false,
      enableStreamlinedLeftNavigation: parsed.data.enableStreamlinedLeftNavigation ?? true,
      enableApps: parsed.data.enableApps ?? false,
      enablePipelines: parsed.data.enablePipelines ?? false,
      enableCases: parsed.data.enableCases ?? false,
      enableConferenceRoomChat: parsed.data.enableConferenceRoomChat ?? false,
      enableIssuePlanDecompositions: parsed.data.enableIssuePlanDecompositions ?? false,
      enableExperimentalFileViewer: parsed.data.enableExperimentalFileViewer ?? false,
      enableTaskWatchdogs: parsed.data.enableTaskWatchdogs ?? false,
      enableCloudSync: parsed.data.enableCloudSync ?? false,
      enableExternalObjects: parsed.data.enableExternalObjects ?? false,
      enableSmokeLab: parsed.data.enableSmokeLab ?? false,
      enableBuiltInAgents: parsed.data.enableBuiltInAgents ?? false,
      enableSummaries: parsed.data.enableSummaries ?? false,
      enableDecisions: parsed.data.enableDecisions ?? false,
      enableGoalsSidebarLink: parsed.data.enableGoalsSidebarLink ?? false,
      enableServerInfoDebugView: parsed.data.enableServerInfoDebugView ?? false,
      autoRestartDevServerWhenIdle: parsed.data.autoRestartDevServerWhenIdle ?? false,
      enableIssueGraphLivenessAutoRecovery: parsed.data.enableIssueGraphLivenessAutoRecovery ?? false,
      cloudBilling:
        process.env.PAPERCLIP_CLOUD_BILLING === "true" ||
        (parsed.data.cloudBilling ?? false),
      cloudTrialBanner:
        process.env.PAPERCLIP_CLOUD_TRIAL_BANNER === "true" ||
        (parsed.data.cloudTrialBanner ?? false),
      enableWorkspaceBranchReconcileForward: parsed.data.enableWorkspaceBranchReconcileForward ?? true,
      enableWorkspaceDirtyQuarantineRepair: parsed.data.enableWorkspaceDirtyQuarantineRepair ?? true,
      enableWorktreeRunExecution: parsed.data.enableWorktreeRunExecution ?? false,
      worktreeRunExecutionActivatedAt: parsed.data.worktreeRunExecutionActivatedAt ?? null,
      worktreeRunExecutionActivationInstanceId:
        parsed.data.worktreeRunExecutionActivationInstanceId ?? null,
      issueGraphLivenessAutoRecoveryLookbackHours:
        parsed.data.issueGraphLivenessAutoRecoveryLookbackHours ??
        DEFAULT_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS,
    };
  }
  return {
    enableEnvironments: false,
    enableIsolatedWorkspaces: false,
    enableStreamlinedLeftNavigation: true,
    enableApps: false,
    enablePipelines: false,
    enableCases: false,
    enableConferenceRoomChat: false,
    enableTaskWatchdogs: false,
    enableIssuePlanDecompositions: false,
    enableExperimentalFileViewer: false,
    enableCloudSync: false,
    enableExternalObjects: false,
    enableSmokeLab: false,
    enableBuiltInAgents: false,
    enableSummaries: false,
    enableDecisions: false,
    enableGoalsSidebarLink: false,
    enableServerInfoDebugView: false,
    autoRestartDevServerWhenIdle: false,
    enableIssueGraphLivenessAutoRecovery: false,
    cloudBilling: process.env.PAPERCLIP_CLOUD_BILLING === "true",
    cloudTrialBanner: process.env.PAPERCLIP_CLOUD_TRIAL_BANNER === "true",
    enableWorkspaceBranchReconcileForward: true,
    enableWorkspaceDirtyQuarantineRepair: true,
    enableWorktreeRunExecution: false,
    worktreeRunExecutionActivatedAt: null,
    worktreeRunExecutionActivationInstanceId: null,
    issueGraphLivenessAutoRecoveryLookbackHours:
      DEFAULT_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS,
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

function toInstanceSettings(
  row: typeof instanceSettings.$inferSelect,
  overrides: InstanceSettingsOverrides = emptyOverrides(),
): InstanceSettings {
  return {
    id: row.id,
    defaultEnvironmentId: row.defaultEnvironmentId ?? null,
    general: resolveGeneralSettings(row.general, overrides.general),
    experimental: resolveExperimentalSettings(row.experimental, overrides.experimental),
    visibility: resolveVisibilitySettings(row.visibility, overrides.visibility),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  } as InstanceSettings;
}

export function instanceSettingsService(db: Db, options: InstanceSettingsServiceOptions = {}) {
  const overrides = parseInstanceSettingsOverrides(options.runtimeEnv ?? process.env);

  async function getOrCreateRow() {
    const existing = await db
      .select()
      .from(instanceSettings)
      .where(eq(instanceSettings.singletonKey, DEFAULT_SINGLETON_KEY))
      .then((rows) => rows[0] ?? null);
    if (existing) return existing;

    const now = new Date();
    const [created] = await db
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

    const raced = await db
      .select()
      .from(instanceSettings)
      .where(eq(instanceSettings.singletonKey, DEFAULT_SINGLETON_KEY))
      .then((rows) => rows[0] ?? null);
    if (raced) return raced;

    throw new Error("Failed to initialize instance settings row");
  }

  return {
    get: async (): Promise<InstanceSettings> => toInstanceSettings(await getOrCreateRow(), overrides),

    update: async (patch: PatchInstanceSettings): Promise<InstanceSettings> => {
      const current = await getOrCreateRow();
      const now = new Date();
      const [updated] = await db
        .update(instanceSettings)
        .set({
          ...(Object.prototype.hasOwnProperty.call(patch, "defaultEnvironmentId")
            ? { defaultEnvironmentId: patch.defaultEnvironmentId ?? null }
            : {}),
          updatedAt: now,
        })
        .where(eq(instanceSettings.id, current.id))
        .returning();
      return toInstanceSettings(updated ?? current, overrides);
    },

    getGeneral: async (): Promise<InstanceGeneralSettings> => {
      const row = await getOrCreateRow();
      return resolveGeneralSettings(row.general, overrides.general);
    },

    getExperimental: async (): Promise<InstanceExperimentalSettings> => {
      const row = await getOrCreateRow();
      return resolveExperimentalSettings(row.experimental, overrides.experimental);
    },

    getVisibility: async (): Promise<InstanceVisibilitySettings> => {
      const row = await getOrCreateRow();
      return resolveVisibilitySettings(row.visibility, overrides.visibility);
    },

    updateGeneral: async (patch: PatchInstanceGeneralSettings): Promise<InstanceSettings> => {
      const current = await getOrCreateRow();
      const effectivePatch = stripOverriddenPatchKeys(
        patch as Record<string, unknown>,
        Object.keys(overrides.general),
      );
      const nextGeneral = normalizeGeneralSettings({
        ...normalizeGeneralSettings(current.general),
        ...effectivePatch,
      });
      const now = new Date();
      const [updated] = await db
        .update(instanceSettings)
        .set({
          general: { ...nextGeneral },
          updatedAt: now,
        })
        .where(eq(instanceSettings.id, current.id))
        .returning();
      return toInstanceSettings(updated ?? current, overrides);
    },

    updateExperimental: async (patch: PatchInstanceExperimentalSettings): Promise<InstanceSettings> => {
      const current = await getOrCreateRow();
      const effectivePatch = stripOverriddenPatchKeys(
        patch as Record<string, unknown>,
        Object.keys(overrides.experimental),
      ) as PatchInstanceExperimentalSettings;
      const nextExperimental = applyExperimentalSettingsPatch(current.experimental, effectivePatch, options);
      const now = new Date();
      const [updated] = await db
        .update(instanceSettings)
        .set({
          experimental: { ...nextExperimental },
          updatedAt: now,
        })
        .where(eq(instanceSettings.id, current.id))
        .returning();
      return toInstanceSettings(updated ?? current, overrides);
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
      return toInstanceSettings(updated ?? current, overrides);
    },

    listCompanyIds: async (): Promise<string[]> =>
      db
        .select({ id: companies.id })
        .from(companies)
        .then((rows) => rows.map((row) => row.id)),
  };
}
