/**
 * Decide what the server startup orchestration must do with the bundled
 * kubernetes sandbox-provider plugin, given its current DB status and whether the
 * built bundle is present on disk.
 *
 * This is the pure decision core of the boot-time `ensureBundledKubernetesPlugin`
 * step (see server/src/app.ts). It is factored out so the branching — including
 * the self-heal path for a plugin that is stuck in a non-`ready` status — can be
 * unit tested without standing up the full app (DB, worker manager, loader).
 *
 * Why self-heal exists: the runtime loader only ACTIVATES plugins in `ready`
 * status (`loadAll()` → `listByStatus("ready")`). If a previous boot left the
 * bundled plugin in `error` (e.g. the manifest was missing before the image
 * shipped it) — or in `installed`/`disabled`/`upgrade_pending` — it would be
 * skipped forever and the kubernetes provider would stay dead, so agents could
 * never acquire a sandbox lease. When the bundle is now present we drive it back
 * to `ready` so the very next `loadAll()` re-activates it (activation re-reads the
 * manifest from disk, so a stale DB record heals).
 */
export type BundledPluginAction =
  /** Already healthy; loadAll() will (re)start its worker. Do nothing. */
  | "skip-ready"
  /** An admin explicitly removed it; respect that and do not reinstall. */
  | "skip-uninstalled"
  /** Stuck in a non-ready status and the bundle is present: drive it to ready. */
  | "self-heal"
  /** Stuck in a non-ready status but the bundle is missing: cannot recover. */
  | "self-heal-blocked-bundle-missing"
  /** Not in the DB and the bundle is present: install it. */
  | "install"
  /** Not in the DB and the bundle is absent (local dev / image without it). */
  | "skip-bundle-missing";

export function decideBundledPluginAction(input: {
  /** The plugin's current DB status, or null/undefined when it is not in the DB. */
  existingStatus: string | null | undefined;
  /** Whether the built bundle (dist/manifest.js) is present on disk. */
  bundlePresent: boolean;
}): BundledPluginAction {
  const { existingStatus, bundlePresent } = input;

  if (existingStatus == null) {
    return bundlePresent ? "install" : "skip-bundle-missing";
  }
  if (existingStatus === "ready") return "skip-ready";
  if (existingStatus === "uninstalled") return "skip-uninstalled";

  // error | installed | disabled | upgrade_pending — needs reactivation.
  return bundlePresent ? "self-heal" : "self-heal-blocked-bundle-missing";
}
