import type { PluginWorkerManager } from "./plugin-worker-manager.js";

/**
 * Process-scoped access to the plugin worker manager.
 *
 * There is exactly ONE plugin worker manager per server process, which is why a
 * run that cannot find one fails with "sandbox plugin workers are unavailable in
 * this server process". Despite being process-scoped, it used to be threaded as
 * an OPTIONAL parameter through six runtime construction sites and dozens of
 * route mounts, so any caller that omitted it built a run engine that could
 * never acquire a sandbox lease. The omission only surfaced when a customer hit
 * that particular path, and it recurred three times:
 *
 *   - routes mounted without it (fixed per-route in #304)
 *   - `heartbeatService(db)` called with no options at all, which is how
 *     `assignment` and `automation` dispatches reached a manager-less runtime
 *
 * Registering it once at boot removes the whole class: a caller can still pass
 * one explicitly (tests do), but forgetting to is no longer a failure mode.
 *
 * Deliberately not a general service locator. It holds this one process-scoped
 * dependency, because the alternative was making it a required parameter on
 * every construction site, which is both a much larger change and still
 * bypassable with `undefined as any`.
 */
let processPluginWorkerManager: PluginWorkerManager | undefined;

/**
 * Register the manager for this process. Called once during app construction.
 * Idempotent: registering the same manager twice is a no-op, and replacing it
 * is allowed so a test harness can install its own.
 */
export function setProcessPluginWorkerManager(manager: PluginWorkerManager | undefined): void {
  processPluginWorkerManager = manager;
}

/**
 * The manager for this process, or undefined when nothing has registered one.
 *
 * Returning undefined rather than throwing is deliberate: contexts that
 * legitimately have no worker (migrations, CLI entrypoints, unit tests that
 * never dispatch a run) must keep working, and the sandbox driver already
 * produces an accurate, non-retryable error when it genuinely has no manager.
 */
export function getProcessPluginWorkerManager(): PluginWorkerManager | undefined {
  return processPluginWorkerManager;
}

/** Test hook: drop the registration so a test can assert the no-manager path. */
export function clearProcessPluginWorkerManager(): void {
  processPluginWorkerManager = undefined;
}
